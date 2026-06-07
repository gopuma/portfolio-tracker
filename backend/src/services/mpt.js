/**
 * Modern Portfolio Theory optimizer.
 * Given daily { date, close } series for a set of instruments, finds long-only
 * weights (w >= 0, sum = 1) that maximize the Sharpe ratio (the tangency portfolio),
 * plus the minimum-variance and equal-weight portfolios for comparison.
 *
 * Approach: build the annualized mean-return vector and covariance matrix from the
 * common-date daily returns, then search the weight simplex by Monte-Carlo sampling
 * followed by hill-climbing refinement (no QP dependency).
 */
import { TRADING_DAYS, MIN_RETURNS, toReturns } from './stats.js';

export function optimizePortfolio(seriesBySymbol, { rf = 0, samples = 40000 } = {}) {
  // 1. Daily-return maps for symbols with enough history.
  const syms = [];
  const maps = [];
  for (const [sym, series] of seriesBySymbol) {
    const { map } = toReturns(series);
    if (map.size >= MIN_RETURNS) { syms.push(sym); maps.push(map); }
  }
  const skipped = [...seriesBySymbol.keys()].filter(s => !syms.includes(s));
  if (syms.length < 2) return { error: 'Need at least 2 instruments with enough price history.', skipped };

  // 2. Common trading dates across all instruments.
  let common = null;
  for (const m of maps) {
    const keys = new Set(m.keys());
    common = common === null ? keys : new Set([...common].filter(d => keys.has(d)));
  }
  const dates = [...common].sort();
  if (dates.length < MIN_RETURNS) return { error: 'Not enough overlapping price history across these instruments.', skipped };

  const n = syms.length;
  const T = dates.length;
  const R = dates.map(d => maps.map(m => m.get(d))); // R[t][i]

  // 3. Annualized mean vector (μ) and covariance matrix (Σ).
  const colMean = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { let s = 0; for (let t = 0; t < T; t++) s += R[t][i]; colMean[i] = s / T; }
  const mu = colMean.map(m => m * TRADING_DAYS);
  const cov = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (R[t][i] - colMean[i]) * (R[t][j] - colMean[j]);
      const c = (s / (T - 1)) * TRADING_DAYS;
      cov[i][j] = c; cov[j][i] = c;
    }
  }
  const vol = cov.map((row, i) => Math.sqrt(Math.max(row[i], 0)));

  const pRet = w => { let s = 0; for (let i = 0; i < n; i++) s += w[i] * mu[i]; return s; };
  const pVar = w => {
    let s = 0;
    for (let i = 0; i < n; i++) { const row = cov[i]; for (let j = 0; j < n; j++) s += w[i] * w[j] * row[j]; }
    return s;
  };
  const sharpe = w => { const v = Math.sqrt(Math.max(pVar(w), 1e-12)); return (pRet(w) - rf) / v; };

  // 4. Monte-Carlo over the simplex (Dirichlet(1) via normalized exponentials).
  let bestS = -Infinity, bestSW = null, bestV = Infinity, bestVW = null;
  const w = new Array(n);
  for (let s = 0; s < samples; s++) {
    let sum = 0;
    for (let i = 0; i < n; i++) { const e = -Math.log(1 - Math.random()); w[i] = e; sum += e; }
    for (let i = 0; i < n; i++) w[i] /= sum;
    const sh = sharpe(w);
    if (sh > bestS) { bestS = sh; bestSW = w.slice(); }
    const v = pVar(w);
    if (v < bestV) { bestV = v; bestVW = w.slice(); }
  }

  // 5. Hill-climb refine the max-Sharpe weights (move weight between two assets).
  let cur = bestSW, curS = bestS, step = 0.1;
  for (let it = 0; it < 5000; it++) {
    const i = Math.floor(Math.random() * n);
    const j = Math.floor(Math.random() * n);
    if (i === j) continue;
    const delta = Math.min(Math.random() * step, cur[i]);
    if (delta <= 0) continue;
    const cand = cur.slice();
    cand[i] -= delta; cand[j] += delta;
    const sh = sharpe(cand);
    if (sh > curS) { curS = sh; cur = cand; }
    if (it % 600 === 599) step *= 0.6;
  }
  bestSW = cur;

  const pack = (weights) => {
    const obj = {};
    weights.forEach((x, i) => { obj[syms[i]] = x; });
    const ret = pRet(weights);
    const v = Math.sqrt(Math.max(pVar(weights), 0));
    return { weights: obj, exp_return: ret, vol: v, sharpe: v > 0 ? (ret - rf) / v : null };
  };

  return {
    rf,
    n,
    n_obs: T,
    from_date: dates[0],
    to_date: dates[dates.length - 1],
    symbols: syms,
    skipped,
    assets: syms.map((s, i) => ({ symbol: s, exp_return: mu[i], vol: vol[i] })),
    max_sharpe: pack(bestSW),
    min_variance: pack(bestVW),
    equal_weight: pack(new Array(n).fill(1 / n)),
  };
}
