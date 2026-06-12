import express from 'express';
import { query, getInstrument } from '../db.js';
import { fetchAndStorePrices, fetchQuoteMeta, searchSymbols } from '../services/priceFetcher.js';
import { predictAndStore } from '../services/prediction.js';

export const instrumentsRouter = express.Router();

const ASSET_CLASSES = ['STOCK', 'ETF', 'BOND_ETF', 'COMMODITY', 'CASH', 'CRYPTO', 'REIT'];
const BACKFILL_DAYS = 1825; // ~5 years on add, so risk/volatility metrics work out of the box

// Instruments other features depend on — not removable (gold-gap, FX/VIX cards, alpha/beta benchmarks).
const PROTECTED = new Set(['GC=F', 'KRX-GOLD-SPOT', 'KRW=X', '^VIX', '^GSPC', '^KS11']);

/**
 * Add a new tracked ticker, then backfill its price history into MySQL.
 * Body: { symbol, market: 'US'|'KR', asset_class?, display_name?, currency? }
 * Volatility / risk metrics are derived from the stored prices by /api/analytics,
 * so backfilling prices is all that's needed.
 */
instrumentsRouter.post('/', async (req, res, next) => {
  try {
    let { symbol, market, asset_class, display_name, currency } = req.body || {};
    symbol = (symbol || '').trim();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    if (!['US', 'KR'].includes(market)) return res.status(400).json({ error: "market must be 'US' or 'KR'" });
    asset_class = ASSET_CLASSES.includes(asset_class) ? asset_class : 'STOCK';

    // Korean tickers on Yahoo use the .KS suffix — apply it if the user omitted it.
    if (market === 'KR' && /^\d{6}$/.test(symbol)) symbol = `${symbol}.KS`;

    const existing = await getInstrument(symbol);
    if (existing) {
      // Already tracked on the watchlist → conflict. Tracked only for a portfolio → promote to watchlist.
      if (existing.watchlist) return res.status(409).json({ error: `${symbol} is already tracked` });
      await query(`UPDATE instruments SET watchlist = 1, market = ?, asset_class = ? WHERE id = ?`, [market, asset_class, existing.id]);
      return res.status(200).json({ instrument: { ...existing, watchlist: 1, market, asset_class }, promoted: true });
    }

    // Validate on Yahoo and pull a default name/currency.
    const meta = await fetchQuoteMeta(symbol);
    if (!meta) return res.status(404).json({ error: `Ticker "${symbol}" not found on Yahoo Finance` });

    const finalName = (display_name || '').trim() || meta.name || symbol;
    const finalCurrency = (currency || '').trim() || meta.currency || (market === 'KR' ? 'KRW' : 'USD');

    // watchlist=1 — explicitly added to the Overview market tables.
    const result = await query(
      `INSERT INTO instruments (symbol, display_name, asset_class, currency, market, category, watchlist)
       VALUES (?, ?, ?, ?, ?, 'user-added', 1)`,
      [symbol, finalName, asset_class, finalCurrency, market]
    );
    const inst = { id: result.insertId, symbol, display_name: finalName, asset_class, currency: finalCurrency, market };

    // Backfill ~5y of prices into MySQL, then compute an initial prediction.
    let backfill = null;
    try { backfill = await fetchAndStorePrices(inst, BACKFILL_DAYS); }
    catch (e) { backfill = { error: e.message }; }
    try { await predictAndStore(inst); } catch { /* prediction is best-effort */ }

    res.status(201).json({ instrument: inst, backfill });
  } catch (e) { next(e); }
});

instrumentsRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT i.*, lp.close_px AS latest_close, lp.trade_date AS latest_date
       FROM instruments i
       LEFT JOIN v_latest_prices lp ON lp.instrument_id = i.id
       WHERE i.is_active = 1
       ORDER BY i.market, i.symbol`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

const isKoreanListing = (s) => /\.(KS|KQ)$/i.test(s);

/**
 * Tracked instruments in our DB that match by symbol or name. Covers synthetic
 * tickers that aren't on Yahoo — notably the KRX gold spot (KRX-GOLD-SPOT, shown
 * as "Gold: KRX" on the Overview), so it can be registered into a portfolio.
 */
async function searchLocalInstruments(q) {
  const like = `%${q}%`;
  const rows = await query(
    `SELECT symbol, display_name, market, asset_class
       FROM instruments
      WHERE is_active = 1 AND (symbol LIKE ? OR display_name LIKE ?)
      ORDER BY market, symbol
      LIMIT 8`,
    [like, like]
  );
  return rows.map(r => ({
    symbol: r.symbol,
    name: r.display_name || r.symbol,
    exchange: r.market === 'KR' ? 'KRX' : (r.market || ''),
    type: r.asset_class,
  }));
}

/**
 * Search tickers by name or symbol.
 *   ?market=US|KR  → restrict to that market's listings (used by the Overview "+ Add ticker").
 *   no market      → seamless cross-market search for the portfolio "Register a Ticker" card:
 *                    US listings first, then Korean listings (.KS/.KQ), then any matching
 *                    locally-tracked instruments (e.g. the KRX gold spot), merged and de-duped.
 * Korean tickers carry a .KS/.KQ suffix; US ones don't.
 */
instrumentsRouter.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const market = req.query.market;

    if (market === 'US' || market === 'KR') {
      let results = await searchSymbols(q);
      results = results.filter(r => market === 'KR' ? isKoreanListing(r.symbol) : !r.symbol.includes('.'));
      return res.json({ results });
    }

    // Search US first, then the Korean market, so a company is found in either
    // without the user picking a market. Two Yahoo searches: the default
    // (US/global) and one biased to Korea to surface .KS/.KQ listings reliably,
    // plus our own DB for synthetic instruments Yahoo doesn't carry.
    const [usHits, krHits, localHits] = await Promise.all([
      searchSymbols(q),
      searchSymbols(q, 8, { region: 'KR', lang: 'ko-KR' }),
      searchLocalInstruments(q),
    ]);

    const seen = new Set();
    const results = [];
    // US listings first…
    for (const r of usHits) {
      if (isKoreanListing(r.symbol) || seen.has(r.symbol)) continue;
      seen.add(r.symbol); results.push(r);
    }
    // …then Korean listings (from either search)…
    for (const r of [...usHits, ...krHits]) {
      if (!isKoreanListing(r.symbol) || seen.has(r.symbol)) continue;
      seen.add(r.symbol); results.push(r);
    }
    // …then any locally-tracked instruments Yahoo didn't already cover.
    for (const r of localHits) {
      if (seen.has(r.symbol)) continue;
      seen.add(r.symbol); results.push(r);
    }
    res.json({ results });
  } catch (e) { next(e); }
});

/** Live Yahoo lookup for a symbol — name, currency, latest price. Used to prefill the add-holding form. */
instrumentsRouter.get('/lookup', async (req, res, next) => {
  try {
    const symbol = (req.query.symbol || '').trim();
    if (!symbol) return res.status(400).json({ error: 'symbol query param is required' });
    const meta = await fetchQuoteMeta(/^\d{6}$/.test(symbol) ? `${symbol}.KS` : symbol);
    if (meta) return res.json(meta);
    // Not on Yahoo (e.g. synthetic KRX-GOLD-SPOT) — fall back to the tracked
    // instrument's latest stored close so the form can still auto-fill a price.
    const inst = await getInstrument(symbol);
    if (inst) {
      const latest = await query(`SELECT close_px FROM v_latest_prices WHERE instrument_id = ?`, [inst.id]);
      return res.json({
        symbol: inst.symbol,
        name: inst.display_name || inst.symbol,
        currency: inst.currency || null,
        price: latest[0] ? Number(latest[0].close_px) : null,
        quote_type: inst.asset_class || null,
        exchange: inst.market || null,
      });
    }
    return res.status(404).json({ error: `Ticker "${symbol}" not found on Yahoo Finance` });
  } catch (e) { next(e); }
});

/**
 * Bulk-remove tracked tickers (and their cascaded price/sentiment/prediction rows).
 * Optional ?market=US|KR scopes it. Protected reference instruments are always kept.
 */
instrumentsRouter.delete('/', async (req, res, next) => {
  try {
    const { market } = req.query;
    const prot = [...PROTECTED];
    const params = [...prot];
    let sql = `DELETE FROM instruments WHERE symbol NOT IN (${prot.map(() => '?').join(',')})`;
    if (market) { sql += ' AND market = ?'; params.push(market); }
    const r = await query(sql, params);
    res.json({ deleted: r.affectedRows ?? 0, market: market || 'all' });
  } catch (e) { next(e); }
});

/** Remove a single tracked ticker (cascades to its prices/sentiment/predictions). */
instrumentsRouter.delete('/:symbol', async (req, res, next) => {
  try {
    const { symbol } = req.params;
    if (PROTECTED.has(symbol)) {
      return res.status(403).json({ error: `${symbol} is used by other features and can't be removed` });
    }
    const inst = await getInstrument(symbol);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    // If a portfolio still holds this symbol, hide it from the watchlist instead of
    // deleting (deleting would orphan the holding and lose its price history).
    const used = await query('SELECT COUNT(*) AS n FROM portfolio_holdings WHERE symbol = ?', [symbol]);
    if (Number(used[0].n) > 0) {
      await query('UPDATE instruments SET watchlist = 0 WHERE id = ?', [inst.id]);
      return res.json({ hidden: 1, symbol, note: 'Still held in a portfolio — removed from the watchlist but kept for the portfolio.' });
    }
    await query('DELETE FROM instruments WHERE id = ?', [inst.id]);
    res.json({ deleted: 1, symbol });
  } catch (e) { next(e); }
});

instrumentsRouter.get('/:symbol', async (req, res, next) => {
  try {
    const inst = await getInstrument(req.params.symbol);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    const latest = await query(
      `SELECT trade_date, close_px FROM v_latest_prices WHERE instrument_id = ?`,
      [inst.id]
    );
    res.json({ ...inst, latest: latest[0] || null });
  } catch (e) { next(e); }
});
