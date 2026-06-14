/**
 * drift-v1 — random walk WITH drift. Estimates the average daily log return over a
 * trailing window and extrapolates it h trading days forward:
 *   predicted_price = base * exp(mu * h),  mu = mean(log returns)
 * Confidence rises with the drift's signal-to-noise ratio (|mu| vs daily vol).
 */
import { logReturns, mean } from '../features.js';
import { stdev, clamp } from '../../prediction.js';

export function predict(ctx, horizon, config = {}) {
  const window = config.window || 252;
  const base = ctx.closes[ctx.closes.length - 1];
  const r = logReturns(ctx.closes.slice(-(window + 1)));
  const mu = r.length ? mean(r) : 0;
  const sigma = r.length >= 2 ? stdev(r) : 0;

  const logChange = mu * horizon;
  const predicted = base * Math.exp(logChange);
  const snr = sigma > 0 ? Math.abs(mu) / sigma : 0;        // per-day signal/noise
  const confidence = clamp(0.4 + 0.5 * Math.tanh(snr * Math.sqrt(horizon)), 0, 0.95);

  return {
    predicted_return: predicted / base - 1,
    predicted_price: +predicted.toFixed(4),
    confidence: +confidence.toFixed(4),
    factors: { mu_daily: +mu.toFixed(6), sigma_daily: +sigma.toFixed(6), window },
  };
}
