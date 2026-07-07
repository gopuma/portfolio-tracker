/**
 * Period-average FX conversion for the research feature. Statement figures are stored in
 * each company's native currency; to compare/convert them we average the FX rate over the
 * fiscal period (flow-correct for revenue/earnings), routing everything through USD.
 *
 * Supported currencies: USD, KRW, JPY — via the FX instruments we already track:
 *   KRW=X    → KRW per USD
 *   JPYKRW=X → KRW per JPY
 * Other reporting currencies fall back to no conversion (the route flags this).
 */
import { query } from '../db.js';

const PAIR_KRW_PER_USD = 'KRW=X';
const PAIR_KRW_PER_JPY = 'JPYKRW=X';
const SUPPORTED = new Set(['USD', 'KRW', 'JPY']);

async function loadFxSeries(symbol) {
  const rows = await query(
    `SELECT DATE_FORMAT(p.trade_date,'%Y-%m-%d') d, p.close_px c
       FROM prices p JOIN instruments i ON i.id = p.instrument_id
      WHERE i.symbol = ? ORDER BY p.trade_date ASC`,
    [symbol]
  );
  return rows.map(r => ({ d: r.d, c: Number(r.c) }));
}

// Average close over [start, end]; if the window has no points, use the latest close
// on or before `end` so early periods (before our FX history begins) still convert.
function avgOver(series, start, end) {
  let sum = 0, n = 0, fallback = null;
  for (const r of series) {
    if (r.d <= end) fallback = r.c;
    if (r.d >= start && r.d <= end) { sum += r.c; n++; }
  }
  return n > 0 ? sum / n : fallback;
}

/**
 * Build a period-average converter from `nativeCcy` → `targetCcy`.
 * Returns { supported, convert(amount, { start, end }) }. `targetCcy` 'native' (or equal
 * to native) is a pass-through.
 */
export async function buildConverter(nativeCcy, targetCcy) {
  nativeCcy = (nativeCcy || '').toUpperCase();
  targetCcy = (targetCcy || '').toUpperCase();

  if (!nativeCcy || !targetCcy || targetCcy === 'NATIVE' || nativeCcy === targetCcy) {
    return { supported: true, convert: amt => amt };
  }
  if (!SUPPORTED.has(nativeCcy) || !SUPPORTED.has(targetCcy)) {
    return { supported: false, convert: amt => amt };
  }

  const krwUsd = await loadFxSeries(PAIR_KRW_PER_USD);
  const needJpy = nativeCcy === 'JPY' || targetCcy === 'JPY';
  const krwJpy = needJpy ? await loadFxSeries(PAIR_KRW_PER_JPY) : [];

  const toUsd = (amt, p, ccy) => {
    if (ccy === 'USD') return amt;
    const kUsd = avgOver(krwUsd, p.start, p.end); // KRW per USD
    if (ccy === 'KRW') return kUsd ? amt / kUsd : null;
    const kJpy = avgOver(krwJpy, p.start, p.end);  // KRW per JPY
    return kUsd && kJpy ? (amt * kJpy) / kUsd : null; // JPY → KRW → USD
  };
  const fromUsd = (usd, p, ccy) => {
    if (usd == null) return null;
    if (ccy === 'USD') return usd;
    const kUsd = avgOver(krwUsd, p.start, p.end);
    if (ccy === 'KRW') return kUsd ? usd * kUsd : null;
    const kJpy = avgOver(krwJpy, p.start, p.end);
    return kUsd && kJpy ? (usd * kUsd) / kJpy : null; // USD → KRW → JPY
  };

  return {
    supported: true,
    convert: (amt, period) => {
      if (amt == null) return null;
      return fromUsd(toUsd(amt, period, nativeCcy), period, targetCcy);
    },
  };
}
