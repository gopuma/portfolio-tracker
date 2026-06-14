/**
 * ridge-v1 — ridge (L2-regularized linear) regression mapping technical-analysis
 * features to the h-step-ahead cumulative log return.
 *
 * Training is strictly point-in-time: for the supplied closes[0..i], we form pairs
 * (featureRow(closes, j), log(closes[j+h]/closes[j])) for every j with j+h <= i.
 * Because featureRow(closes, j) only inspects data at-or-before j, and the target's
 * realized price index j+h is itself <= i (already observed), there is no leakage.
 * Features are standardized; the intercept is unpenalized.
 */
import { featureRow, mean } from '../features.js';
import { ridgeSolve } from '../linalg.js';
import { stdev, clamp } from '../../prediction.js';

export function predict(ctx, horizon, config = {}) {
  const lambda = config.alpha ?? 1.0;
  const base = ctx.closes[ctx.closes.length - 1];
  const last = ctx.closes.length - 1;

  // Assemble training rows + targets (bounded to the most recent `train` pairs so
  // the walk-forward backtest stays fast; all rows are still <= the as-of index).
  const train = config.train || 252;
  const rawX = [], y = [];
  for (let j = Math.max(50, last - horizon - train); j + horizon <= last; j++) {
    const f = featureRow(ctx.closes, j);
    if (!f) continue;
    const cj = ctx.closes[j], cjh = ctx.closes[j + horizon];
    if (!(cj > 0) || !(cjh > 0)) continue;
    rawX.push(f);
    y.push(Math.log(cjh / cj));
  }
  const predFeat = featureRow(ctx.closes, last);

  if (rawX.length < 40 || !predFeat) {
    const mu = y.length ? mean(y) : 0;            // fall back to mean drift
    const predicted = base * Math.exp(mu);
    return {
      predicted_return: predicted / base - 1,
      predicted_price: +predicted.toFixed(4),
      confidence: 0.4,
      factors: { fallback: 'mean-drift', n_train: rawX.length },
    };
  }

  // Standardize each feature column (z-score) using training stats.
  const p = rawX[0].length;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(0);
  for (let c = 0; c < p; c++) {
    const col = rawX.map(r => r[c]);
    mu[c] = mean(col);
    sd[c] = stdev(col) || 1;
  }
  const z = row => row.map((v, c) => (v - mu[c]) / sd[c]);
  // Design matrix with leading intercept column (1).
  const X = rawX.map(r => [1, ...z(r)]);
  const penalize = [false, ...new Array(p).fill(true)];
  const beta = ridgeSolve(X, y, lambda, penalize);

  if (!beta) {
    const m = mean(y);
    const predicted = base * Math.exp(m);
    return {
      predicted_return: predicted / base - 1,
      predicted_price: +predicted.toFixed(4),
      confidence: 0.4,
      factors: { fallback: 'mean-drift', reason: 'singular' },
    };
  }

  // In-sample R^2 -> confidence.
  const yMean = mean(y);
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < X.length; i++) {
    let yhat = 0;
    for (let a = 0; a < X[i].length; a++) yhat += beta[a] * X[i][a];
    ssRes += (y[i] - yhat) ** 2;
    ssTot += (y[i] - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? clamp(1 - ssRes / ssTot, 0, 1) : 0;

  // Predict for the latest feature row.
  const xPred = [1, ...z(predFeat)];
  let pred = 0;
  for (let a = 0; a < xPred.length; a++) pred += beta[a] * xPred[a];
  const predicted = base * Math.exp(pred);

  return {
    predicted_return: predicted / base - 1,
    predicted_price: +predicted.toFixed(4),
    confidence: +clamp(0.35 + 0.5 * r2, 0, 0.95).toFixed(4),
    factors: { lambda, n_train: rawX.length, r2: +r2.toFixed(4) },
  };
}
