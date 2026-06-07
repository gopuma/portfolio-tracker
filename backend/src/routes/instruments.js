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

/**
 * Search tickers by name or symbol. Optional ?market=US|KR restricts results to
 * that market's listings (Korean tickers carry a .KS/.KQ suffix; US ones don't).
 */
instrumentsRouter.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    let results = await searchSymbols(q);
    const market = req.query.market;
    if (market === 'KR') results = results.filter(r => /\.(KS|KQ)$/i.test(r.symbol));
    else if (market === 'US') results = results.filter(r => !r.symbol.includes('.'));
    res.json({ results });
  } catch (e) { next(e); }
});

/** Live Yahoo lookup for a symbol — name, currency, latest price. Used to prefill the add-holding form. */
instrumentsRouter.get('/lookup', async (req, res, next) => {
  try {
    const symbol = (req.query.symbol || '').trim();
    if (!symbol) return res.status(400).json({ error: 'symbol query param is required' });
    const meta = await fetchQuoteMeta(/^\d{6}$/.test(symbol) ? `${symbol}.KS` : symbol);
    if (!meta) return res.status(404).json({ error: `Ticker "${symbol}" not found on Yahoo Finance` });
    res.json(meta);
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
