import express from 'express';
import { query } from '../db.js';
import { ensureTrackedInstrument } from '../services/instrumentService.js';
import { fetchQuotes } from '../services/priceFetcher.js';

export const portfoliosRouter = express.Router();

const MAX_HOLDINGS = 30;

// Cache the live FX rate briefly so back-to-back portfolio reads don't each hit Yahoo.
const FX_TTL_MS = 60_000;
let fxCache = { rate: null, at: 0 };

// Latest USD/KRW (KRW per USD) for converting holding values to a common base.
// Prefers the live Yahoo quote so conversions use the current rate, falling back
// to the most recent stored EOD close if the live lookup is unavailable.
async function getKrwPerUsd() {
  const now = Date.now();
  if (fxCache.rate && now - fxCache.at < FX_TTL_MS) return fxCache.rate;

  try {
    const q = await fetchQuotes(['KRW=X']);
    const live = q['KRW=X']?.price;
    if (live && live > 0) { fxCache = { rate: Number(live), at: now }; return fxCache.rate; }
  } catch { /* fall back to the stored close below */ }

  const rows = await query(
    `SELECT lp.close_px FROM instruments i
       JOIN v_latest_prices lp ON lp.instrument_id = i.id
      WHERE i.symbol = 'KRW=X'`
  );
  const rate = rows[0] ? Number(rows[0].close_px) : null;
  if (rate) fxCache = { rate, at: now };
  return rate;
}

function convert(amount, currency, base, krwPerUsd) {
  if (amount == null) return null;
  if (currency === base) return amount;
  if (!krwPerUsd) return amount; // can't convert; treat 1:1 (shouldn't happen — KRW=X is seeded)
  if (base === 'USD' && currency === 'KRW') return amount / krwPerUsd;
  if (base === 'KRW' && currency === 'USD') return amount * krwPerUsd;
  return amount;
}

// Holdings with latest + historical closes for one portfolio.
async function loadHoldings(portfolioId) {
  return query(
    `SELECT h.id, h.symbol, h.account, h.shares, h.cost_price, h.currency,
            i.id AS instrument_id, i.display_name,
            lp.close_px AS latest_close, lp.trade_date AS latest_date,
            (SELECT close_px FROM prices p WHERE p.instrument_id = i.id AND p.trade_date <= DATE_SUB(CURDATE(), INTERVAL 1 YEAR) ORDER BY p.trade_date DESC LIMIT 1) AS close_1y,
            (SELECT close_px FROM prices p WHERE p.instrument_id = i.id AND p.trade_date <= DATE_SUB(CURDATE(), INTERVAL 3 YEAR) ORDER BY p.trade_date DESC LIMIT 1) AS close_3y,
            (SELECT close_px FROM prices p WHERE p.instrument_id = i.id AND p.trade_date <= DATE_SUB(CURDATE(), INTERVAL 5 YEAR) ORDER BY p.trade_date DESC LIMIT 1) AS close_5y
       FROM portfolio_holdings h
       LEFT JOIN instruments i ON i.symbol = h.symbol COLLATE utf8mb4_unicode_ci
       LEFT JOIN v_latest_prices lp ON lp.instrument_id = i.id
      WHERE h.portfolio_id = ?
      ORDER BY h.symbol ASC`,
    [portfolioId]
  );
}

// Enrich each holding with value/returns and roll up portfolio-level returns.
// Per-holding window returns are native-currency price returns (FX-independent);
// the portfolio figure is those returns value-weighted by current base-currency value.
function computePortfolio(rows, base, krwPerUsd) {
  const holdings = rows.map(r => {
    const latest = r.latest_close != null ? Number(r.latest_close) : null;
    const cost = Number(r.cost_price);
    const shares = Number(r.shares);
    const mvNative = latest != null ? shares * latest : null;
    const mvBase = convert(mvNative, r.currency, base, krwPerUsd);
    const costBase = convert(shares * cost, r.currency, base, krwPerUsd);
    const ret = (then) => (latest != null && then != null && Number(then) > 0 ? latest / Number(then) - 1 : null);
    return {
      id: r.id,
      symbol: r.symbol,
      account: r.account || '',
      display_name: r.display_name,
      currency: r.currency,
      shares,
      cost_price: cost,
      latest_close: latest,
      latest_date: r.latest_date,
      market_value: mvNative,
      market_value_base: mvBase,
      cost_basis_base: costBase,
      return_inception: cost > 0 && latest != null ? latest / cost - 1 : null,
      return_1y: ret(r.close_1y),
      return_3y: ret(r.close_3y),
      return_5y: ret(r.close_5y),
    };
  });

  const totalValue = holdings.reduce((a, h) => a + (h.market_value_base || 0), 0);
  const totalCost = holdings.reduce((a, h) => a + (h.cost_basis_base || 0), 0);
  for (const h of holdings) h.weight = totalValue > 0 ? (h.market_value_base || 0) / totalValue : null;

  const weighted = (key) => {
    let num = 0, den = 0;
    for (const h of holdings) {
      if (h[key] != null && h.market_value_base) { num += h.market_value_base * h[key]; den += h.market_value_base; }
    }
    return den > 0 ? num / den : null;
  };

  return {
    holdings,
    totals: {
      base_currency: base,
      market_value: totalValue,
      cost_basis: totalCost,
      gain: totalValue - totalCost,
      return_inception: totalCost > 0 ? totalValue / totalCost - 1 : null,
      return_1y: weighted('return_1y'),
      return_3y: weighted('return_3y'),
      return_5y: weighted('return_5y'),
    },
  };
}

/** List all portfolios with rolled-up returns. */
portfoliosRouter.get('/', async (_req, res, next) => {
  try {
    const portfolios = await query(`SELECT id, name, base_currency, created_at FROM portfolios ORDER BY created_at DESC`);
    const krwPerUsd = await getKrwPerUsd();
    const out = [];
    for (const p of portfolios) {
      const rows = await loadHoldings(p.id);
      const { totals } = computePortfolio(rows, p.base_currency, krwPerUsd);
      out.push({ ...p, holdings_count: rows.length, ...totals });
    }
    res.json({ count: out.length, portfolios: out });
  } catch (e) { next(e); }
});

/** Create a portfolio. Body: { name, base_currency? } */
portfoliosRouter.post('/', async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const base = ['USD', 'KRW'].includes(req.body?.base_currency) ? req.body.base_currency : 'USD';
    const r = await query(`INSERT INTO portfolios (name, base_currency) VALUES (?, ?)`, [name, base]);
    res.status(201).json({ id: r.insertId, name, base_currency: base });
  } catch (e) { next(e); }
});

/** Portfolio detail with holdings + returns. */
portfoliosRouter.get('/:id', async (req, res, next) => {
  try {
    const rows = await query(`SELECT id, name, base_currency, created_at FROM portfolios WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Portfolio not found' });
    const p = rows[0];
    const krwPerUsd = await getKrwPerUsd();
    const holdingRows = await loadHoldings(p.id);
    const { holdings, totals } = computePortfolio(holdingRows, p.base_currency, krwPerUsd);
    res.json({ ...p, max_holdings: MAX_HOLDINGS, krw_per_usd: krwPerUsd, holdings, totals });
  } catch (e) { next(e); }
});

/** Rename a portfolio. Body: { name } */
portfoliosRouter.patch('/:id', async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const r = await query(`UPDATE portfolios SET name = ? WHERE id = ?`, [name, req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Portfolio not found' });
    res.json({ id: Number(req.params.id), name });
  } catch (e) { next(e); }
});

/** Delete a portfolio. Refused unless it's empty — all holdings must be removed first. */
portfoliosRouter.delete('/:id', async (req, res, next) => {
  try {
    const pf = await query(`SELECT id FROM portfolios WHERE id = ?`, [req.params.id]);
    if (pf.length === 0) return res.status(404).json({ error: 'Portfolio not found' });

    const [{ n }] = await query(`SELECT COUNT(*) AS n FROM portfolio_holdings WHERE portfolio_id = ?`, [req.params.id]);
    if (Number(n) > 0) {
      return res.status(409).json({ error: `Remove all ${n} holding${n > 1 ? 's' : ''} before deleting this portfolio` });
    }

    const r = await query(`DELETE FROM portfolios WHERE id = ?`, [req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Portfolio not found' });
    res.json({ deleted: 1 });
  } catch (e) { next(e); }
});

/**
 * Add / update a holding. Body: { symbol, shares, price? }
 * price defaults to the latest close; the ticker is auto-tracked & backfilled if new.
 */
portfoliosRouter.post('/:id/holdings', async (req, res, next) => {
  try {
    const pid = req.params.id;
    const pf = await query(`SELECT id FROM portfolios WHERE id = ?`, [pid]);
    if (pf.length === 0) return res.status(404).json({ error: 'Portfolio not found' });

    const shares = Number(req.body?.shares);
    if (!Number.isFinite(shares) || shares <= 0) return res.status(400).json({ error: 'shares must be a positive number' });

    // Optional account label — lets the same ticker be held more than once per
    // portfolio (one lot per account). Same symbol + same account = edit.
    const account = (req.body?.account || '').trim().slice(0, 64);

    let inst, latestClose;
    try {
      const r = await ensureTrackedInstrument(req.body?.symbol);
      inst = r.instrument; latestClose = r.latest_close;
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }

    // Capacity check (existing symbol+account = edit, allowed even at the cap).
    const existing = await query(`SELECT id FROM portfolio_holdings WHERE portfolio_id = ? AND symbol = ? AND account = ?`, [pid, inst.symbol, account]);
    if (existing.length === 0) {
      const [{ n }] = await query(`SELECT COUNT(*) AS n FROM portfolio_holdings WHERE portfolio_id = ?`, [pid]);
      if (Number(n) >= MAX_HOLDINGS) return res.status(400).json({ error: `Portfolio is full (max ${MAX_HOLDINGS} holdings)` });
    }

    const priceInput = req.body?.price != null && req.body.price !== '' ? Number(req.body.price) : null;
    const price = priceInput != null && priceInput > 0 ? priceInput : latestClose;
    if (price == null || !(price > 0)) return res.status(400).json({ error: 'No price available — provide a custom price' });

    await query(
      `INSERT INTO portfolio_holdings (portfolio_id, symbol, account, shares, cost_price, currency)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE shares = VALUES(shares), cost_price = VALUES(cost_price), currency = VALUES(currency)`,
      [pid, inst.symbol, account, shares, price, inst.currency]
    );
    res.status(201).json({ symbol: inst.symbol, account, shares, cost_price: price, currency: inst.currency, latest_close: latestClose });
  } catch (e) { next(e); }
});

/** Update a holding's shares, cost price, and/or account. Body: { shares?, cost_price?, account? } */
portfoliosRouter.patch('/:id/holdings/:holdingId', async (req, res, next) => {
  try {
    const sets = [];
    const params = [];
    const { shares, cost_price, account } = req.body || {};
    if (shares !== undefined) {
      const n = Number(shares);
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'shares must be a positive number' });
      sets.push('shares = ?'); params.push(n);
    }
    if (cost_price !== undefined && cost_price !== '') {
      const c = Number(cost_price);
      if (!Number.isFinite(c) || c <= 0) return res.status(400).json({ error: 'cost_price must be a positive number' });
      sets.push('cost_price = ?'); params.push(c);
    }
    if (account !== undefined) {
      // Account may be blank (clears the label); keyed by (portfolio_id, symbol, account).
      sets.push('account = ?'); params.push(String(account).trim().slice(0, 64));
    }
    if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
    params.push(req.params.holdingId, req.params.id);
    let r;
    try {
      r = await query(`UPDATE portfolio_holdings SET ${sets.join(', ')} WHERE id = ? AND portfolio_id = ?`, params);
    } catch (e) {
      // Renaming the account onto a symbol+account that already exists in this portfolio.
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This ticker is already held under that account — change the account or merge the lots.' });
      throw e;
    }
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Holding not found' });
    res.json({ updated: 1 });
  } catch (e) { next(e); }
});

/** Remove a holding from a portfolio. */
portfoliosRouter.delete('/:id/holdings/:holdingId', async (req, res, next) => {
  try {
    const r = await query(`DELETE FROM portfolio_holdings WHERE id = ? AND portfolio_id = ?`, [req.params.holdingId, req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Holding not found' });
    res.json({ deleted: 1 });
  } catch (e) { next(e); }
});
