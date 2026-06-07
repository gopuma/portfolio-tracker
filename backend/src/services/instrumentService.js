/**
 * Ensure a ticker is tracked in the instruments table with backfilled price history,
 * so downstream features (returns, risk metrics) have data to work with.
 * Used when a user registers a ticker into a portfolio.
 */
import { query, getInstrument } from '../db.js';
import { fetchAndStorePrices, fetchQuoteMeta } from './priceFetcher.js';

const BACKFILL_DAYS = 1825; // ~5 years so 5-year returns work out of the box

// Infer market/currency from the symbol and Yahoo metadata.
function inferMarket(symbol, meta) {
  if (/\.KS$/i.test(symbol) || meta?.currency === 'KRW') return { market: 'KR', currency: meta?.currency || 'KRW' };
  return { market: 'US', currency: meta?.currency || 'USD' };
}

/**
 * @returns {Promise<{instrument: object, created: boolean, latest_close: number|null}>}
 */
export async function ensureTrackedInstrument(rawSymbol) {
  let symbol = (rawSymbol || '').trim();
  if (!symbol) throw Object.assign(new Error('symbol is required'), { status: 400 });
  // 6-digit Korean codes → Yahoo .KS suffix
  if (/^\d{6}$/.test(symbol)) symbol = `${symbol}.KS`;

  let inst = await getInstrument(symbol);
  let created = false;

  if (!inst) {
    const meta = await fetchQuoteMeta(symbol);
    if (!meta) throw Object.assign(new Error(`Ticker "${symbol}" not found on Yahoo Finance`), { status: 404 });
    const { market, currency } = inferMarket(symbol, meta);
    // watchlist=0 — registered for a portfolio, not shown on the Overview market tables.
    const result = await query(
      `INSERT INTO instruments (symbol, display_name, asset_class, currency, market, category, watchlist)
       VALUES (?, ?, 'STOCK', ?, ?, 'portfolio', 0)`,
      [symbol, meta.name || symbol, currency, market]
    );
    inst = { id: result.insertId, symbol, display_name: meta.name || symbol, asset_class: 'STOCK', currency, market };
    created = true;
    try { await fetchAndStorePrices(inst, BACKFILL_DAYS); } catch { /* best-effort backfill */ }
  }

  const latest = await query(`SELECT close_px FROM v_latest_prices WHERE instrument_id = ?`, [inst.id]);
  return { instrument: inst, created, latest_close: latest[0] ? Number(latest[0].close_px) : null };
}
