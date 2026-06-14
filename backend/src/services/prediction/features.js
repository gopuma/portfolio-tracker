/**
 * Point-in-time feature helpers for the prediction competition.
 *
 * Everything here takes a chronological `closes` array (oldest -> newest) and an
 * index, and only ever looks at data at-or-before that index. This is what keeps
 * the walk-forward backtest leak-free: a model evaluated "as of" index i is handed
 * closes.slice(0, i+1) and can never see the future.
 *
 * Reuses the technical-indicator math from ../prediction.js so there is a single
 * source of truth.
 */
import { sma, rsi, stdev } from '../prediction.js';

export function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Daily log returns of a closes series: r_t = ln(c_t / c_{t-1}). */
export function logReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (a > 0 && b > 0) r.push(Math.log(b / a));
  }
  return r;
}

/** Annualization-free daily volatility = stdev of trailing `window` log returns. */
export function dailyVol(closes, window = 30) {
  const r = logReturns(closes.slice(-(window + 1)));
  return r.length >= 2 ? stdev(r) : 0;
}

/**
 * Feature row for the index `j` of `closes` (uses closes[0..j] only).
 * Returns a fixed-length numeric vector, or null if there isn't enough history.
 * Used both to build a model's training matrix and to form the prediction input.
 */
export function featureRow(closes, j) {
  if (j < 50) return null;                 // need SMA50 + RSI windows
  // All features look back ≤ 50 days, so bound the slice to the last 60 closes
  // (still strictly data at-or-before j — keeps it leak-free and O(1) per call,
  // which matters because the ridge model builds a training matrix from this).
  const win = closes.slice(Math.max(0, j - 59), j + 1);
  const price = win[win.length - 1];
  if (!(price > 0)) return null;
  const r = logReturns(win);
  const ret1 = r.at(-1) ?? 0;
  const ret5 = r.length >= 5 ? mean(r.slice(-5)) : 0;
  const ret10 = r.length >= 10 ? mean(r.slice(-10)) : 0;
  const s10 = sma(win, 10), s20 = sma(win, 20), s50 = sma(win, 50);
  const rsi14 = rsi(win, 14);
  const vol30 = dailyVol(win, 30);
  if (s10 == null || s20 == null || s50 == null || rsi14 == null) return null;
  return [
    ret1,
    ret5,
    ret10,
    s10 / price - 1,
    s20 / price - 1,
    s50 / price - 1,
    rsi14 / 100 - 0.5,
    vol30,
  ];
}

export const FEATURE_NAMES = [
  'ret1', 'ret5', 'ret10', 'sma10_gap', 'sma20_gap', 'sma50_gap', 'rsi14_c', 'vol30',
];
