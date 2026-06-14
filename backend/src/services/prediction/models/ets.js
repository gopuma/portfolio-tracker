/**
 * ets-v1 — Holt's linear exponential smoothing (double exponential: level + trend),
 * run on LOG prices so the multiplicative drift is captured additively:
 *   level_t = a*y_t + (1-a)*(level_{t-1} + trend_{t-1})
 *   trend_t = b*(level_t - level_{t-1}) + (1-b)*trend_{t-1}
 * h-step forecast (log space): y_hat = level_T + h*trend_T  ->  price = exp(y_hat).
 * Confidence is derived from in-sample one-step fit quality.
 */
import { logReturns, mean } from '../features.js';
import { stdev, clamp } from '../../prediction.js';

export function predict(ctx, horizon, config = {}) {
  const alpha = config.alpha ?? 0.3;
  const beta = config.beta ?? 0.1;
  const window = config.window || 252;
  const closes = ctx.closes.slice(-window);
  const base = closes[closes.length - 1];

  const ys = closes.filter(c => c > 0).map(Math.log);
  if (ys.length < 5) {
    return {
      predicted_return: 0,
      predicted_price: +base.toFixed(4),
      confidence: 0.4,
      factors: { fallback: 'naive', reason: 'insufficient-history' },
    };
  }

  let level = ys[0];
  let trend = ys[1] - ys[0];
  const errs = [];
  for (let t = 1; t < ys.length; t++) {
    const forecast = level + trend;          // one-step-ahead, pre-update
    errs.push(ys[t] - forecast);
    const prevLevel = level;
    level = alpha * ys[t] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }

  const yHat = level + horizon * trend;
  const predicted = Math.exp(yHat);

  // Confidence from one-step fit error vs the series' own return volatility.
  const fitSd = errs.length >= 2 ? stdev(errs) : 0;
  const retSd = stdev(logReturns(closes)) || 1e-9;
  const confidence = clamp(0.4 + 0.5 * (1 - Math.min(fitSd / retSd, 1)), 0, 0.95);

  return {
    predicted_return: predicted / base - 1,
    predicted_price: +predicted.toFixed(4),
    confidence: +confidence.toFixed(4),
    factors: {
      alpha, beta,
      level: +level.toFixed(6), trend_daily: +trend.toFixed(6),
      fit_sd: +fitSd.toFixed(6),
    },
  };
}
