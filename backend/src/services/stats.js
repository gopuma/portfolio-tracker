/**
 * Return/risk statistics shared by the portfolio and per-instrument analytics routes.
 * All inputs are ordered daily { date:'YYYY-MM-DD', close:Number } series.
 */

export const TRADING_DAYS = 252;   // annualization factor
export const MIN_RETURNS = 20;     // minimum observations to report a stat

const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

// Daily simple returns as both an array and a date->return map (for alignment).
export function toReturns(series) {
  const rets = [];
  const map = new Map();
  for (let i = 1; i < series.length; i++) {
    const r = series[i].close / series[i - 1].close - 1;
    if (!isFinite(r)) continue;
    rets.push(r);
    map.set(series[i].date, r);
  }
  return { rets, map };
}

// Per-asset return & risk stats. Returns null when there isn't enough data.
export function riskStats(series, rf = 0) {
  if (!series || series.length < MIN_RETURNS + 1) return null;
  const closes = series.map(s => s.close);
  const { rets } = toReturns(series);
  const n = rets.length;
  if (n < MIN_RETURNS) return null;

  const mean = avg(rets);
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1); // sample
  const sd = Math.sqrt(variance);

  // Downside deviation: only returns below the daily MAR (risk-free) contribute.
  const dailyMar = rf / TRADING_DAYS;
  const downVar = rets.reduce((a, r) => a + Math.min(r - dailyMar, 0) ** 2, 0) / n;
  const downsideDev = Math.sqrt(downVar);

  // Max drawdown over the window.
  let peak = closes[0];
  let maxDd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = c / peak - 1;
    if (dd < maxDd) maxDd = dd;
  }

  const annMean = mean * TRADING_DAYS;
  const vol = sd * Math.sqrt(TRADING_DAYS);
  const downsideAnn = downsideDev * Math.sqrt(TRADING_DAYS);
  const first = closes[0];
  const last = closes[closes.length - 1];

  return {
    n,
    total_return: last / first - 1,
    cagr: first > 0 ? (last / first) ** (TRADING_DAYS / n) - 1 : null,
    ann_mean_return: annMean,
    vol,
    downside_dev: downsideAnn,
    max_drawdown: maxDd,
    sharpe: vol > 0 ? (annMean - rf) / vol : null,
    sortino: downsideAnn > 0 ? (annMean - rf) / downsideAnn : null,
  };
}

// Pearson correlation of two date->return maps over their common dates.
export function pearsonMaps(ma, mb) {
  if (!ma || !mb) return null;
  const xs = [], ys = [];
  for (const [date, ra] of ma) {
    const rb = mb.get(date);
    if (rb !== undefined) { xs.push(ra); ys.push(rb); }
  }
  const n = xs.length;
  if (n < MIN_RETURNS) return null;
  const mx = avg(xs), my = avg(ys);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  const denom = Math.sqrt(vx * vy);
  return denom > 0 ? cov / denom : null;
}

/**
 * CAPM beta and (annualized Jensen's) alpha of an asset vs. a benchmark,
 * from their date->return maps aligned on common dates.
 *   beta  = cov(asset, bench) / var(bench)
 *   alpha = [mean(asset − rf) − beta · mean(bench − rf)] · 252   (Jensen's alpha)
 * Also returns correlation and R² (how much of the asset's moves the benchmark explains).
 */
export function betaAlpha(assetMap, benchMap, rf = 0) {
  if (!assetMap || !benchMap) return { beta: null, alpha: null, correlation: null, r2: null, n: 0 };
  const a = [], b = [];
  for (const [date, ra] of assetMap) {
    const rb = benchMap.get(date);
    if (rb !== undefined) { a.push(ra); b.push(rb); }
  }
  const n = a.length;
  if (n < MIN_RETURNS) return { beta: null, alpha: null, correlation: null, r2: null, n };

  const ma = avg(a), mb = avg(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  const beta = vb > 0 ? cov / vb : null;
  const dailyMar = rf / TRADING_DAYS;
  const alphaDaily = beta != null ? (ma - dailyMar) - beta * (mb - dailyMar) : null;
  const alpha = alphaDaily != null ? alphaDaily * TRADING_DAYS : null;
  const corr = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
  return { beta, alpha, correlation: corr, r2: corr != null ? corr * corr : null, n };
}

/**
 * Ordinary least squares of asset returns on benchmark returns (date-keyed maps, aligned
 * on common keys), with the standard errors the stress test needs:
 *   beta, alpha (per period), se_beta, resid_sd (per-period residual sd), r2, n.
 * Unlike betaAlpha() this works on any return frequency and annualizes nothing.
 */
export function regress(assetMap, benchMap, minObs = MIN_RETURNS) {
  const empty = { beta: null, alpha: null, se_beta: null, resid_sd: null, r2: null, n: 0 };
  if (!assetMap || !benchMap) return empty;
  const ys = [], xs = [];
  for (const [k, ra] of assetMap) {
    const rb = benchMap.get(k);
    if (rb !== undefined) { ys.push(ra); xs.push(rb); }
  }
  const n = xs.length;
  if (n < minObs) return { ...empty, n };
  const mx = avg(xs), my = avg(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (!(sxx > 0)) return { ...empty, n };
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  const sse = Math.max(syy - beta * sxy, 0);
  const s2 = sse / (n - 2);
  return {
    beta,
    alpha,
    se_beta: Math.sqrt(s2 / sxx),
    resid_sd: Math.sqrt(s2),
    r2: syy > 0 ? 1 - sse / syy : null,
    n,
  };
}
