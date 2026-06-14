/**
 * arima-v1 — an ARIMA(p,1,0)-lite: an autoregressive model of order p fit by least
 * squares on the FIRST DIFFERENCE of log prices (i.e. on log returns). The d=1
 * differencing handles the unit root in prices; we omit the MA term (q=0) to keep
 * it dependency-free, so it's an honest AR(p)-on-returns, not full Box-Jenkins.
 *
 *   r_t = c + a_1 r_{t-1} + ... + a_p r_{t-p} + e_t
 * Forecast h steps by iterating the recursion, then exponentiate the cumulative
 * predicted log return back to a price.
 */
import { logReturns, mean } from '../features.js';
import { solve } from '../linalg.js';
import { clamp } from '../../prediction.js';

export function predict(ctx, horizon, config = {}) {
  const p = config.p ?? 2;
  const window = config.window || 252;
  const base = ctx.closes[ctx.closes.length - 1];
  const r = logReturns(ctx.closes.slice(-(window + 1)));

  // Need enough rows to fit p+1 coefficients with margin.
  if (r.length < p + 10) {
    const mu = r.length ? mean(r) : 0;
    const predicted = base * Math.exp(mu * horizon);
    return {
      predicted_return: predicted / base - 1,
      predicted_price: +predicted.toFixed(4),
      confidence: 0.4,
      factors: { fallback: 'drift', p, reason: 'insufficient-history' },
    };
  }

  // Build design rows [1, r_{t-1..t-p}] -> target r_t.
  const X = [], y = [];
  for (let t = p; t < r.length; t++) {
    const row = [1];
    for (let k = 1; k <= p; k++) row.push(r[t - k]);
    X.push(row);
    y.push(r[t]);
  }
  // Normal equations X'X b = X'y.
  const dim = p + 1;
  const XtX = Array.from({ length: dim }, () => new Array(dim).fill(0));
  const Xty = new Array(dim).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < dim; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < dim; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const coef = solve(XtX, Xty);
  if (!coef) {
    const mu = mean(r);
    const predicted = base * Math.exp(mu * horizon);
    return {
      predicted_return: predicted / base - 1,
      predicted_price: +predicted.toFixed(4),
      confidence: 0.4,
      factors: { fallback: 'drift', p, reason: 'singular' },
    };
  }

  // In-sample R^2 -> confidence.
  const yMean = mean(y);
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < X.length; i++) {
    let yhat = 0;
    for (let a = 0; a < dim; a++) yhat += coef[a] * X[i][a];
    ssRes += (y[i] - yhat) ** 2;
    ssTot += (y[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? clamp(1 - ssRes / ssTot, 0, 1) : 0;

  // Iterate the AR recursion forward h steps, accumulating predicted log returns.
  const hist = r.slice(-p);            // most recent p returns, oldest..newest
  let cum = 0;
  for (let step = 0; step < horizon; step++) {
    let next = coef[0];
    for (let k = 1; k <= p; k++) next += coef[k] * hist[hist.length - k];
    cum += next;
    hist.push(next);
  }
  const predicted = base * Math.exp(cum);

  return {
    predicted_return: predicted / base - 1,
    predicted_price: +predicted.toFixed(4),
    confidence: +clamp(0.35 + 0.5 * r2, 0, 0.95).toFixed(4),
    factors: { p, coef: coef.map(c => +c.toFixed(6)), r2: +r2.toFixed(4), window },
  };
}
