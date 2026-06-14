/**
 * montecarlo-v1 — Geometric Brownian Motion Monte-Carlo. Estimate daily drift (mu)
 * and volatility (sigma) from trailing log returns, then simulate N terminal
 * outcomes h trading days out. Because GBM's h-step log change is Normal(mu*h,
 * sigma^2*h), we can sample the terminal directly (no per-step loop needed):
 *   logChange_i = mu*h + sigma*sqrt(h)*Z_i
 * Point forecast = mean terminal price; 80% prediction interval = 10th/90th pctile.
 *
 * Uses a seeded PRNG (mulberry32 + Box-Muller) so the same inputs always produce
 * the same forecast — required for a reproducible competition.
 */
import { logReturns, mean } from '../features.js';
import { stdev, clamp } from '../../prediction.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, q) {
  const idx = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function predict(ctx, horizon, config = {}) {
  const paths = config.paths || 10000;
  const seed = config.seed ?? 7;
  const window = config.window || 252;
  const base = ctx.closes[ctx.closes.length - 1];

  const r = logReturns(ctx.closes.slice(-(window + 1)));
  const mu = r.length ? mean(r) : 0;
  const sigma = r.length >= 2 ? stdev(r) : 0;
  const drift = mu * horizon;
  const vol = sigma * Math.sqrt(horizon);

  const rng = mulberry32(seed);
  const terminals = new Array(paths);
  for (let i = 0; i < paths; i++) {
    // Box-Muller standard normal.
    const u1 = Math.max(rng(), 1e-12), u2 = rng();
    const zScore = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    terminals[i] = base * Math.exp(drift + vol * zScore);
  }
  terminals.sort((a, b) => a - b);

  const predicted = mean(terminals);
  const piLow = percentile(terminals, 0.10);
  const piHigh = percentile(terminals, 0.90);
  // Tighter interval (relative to price) => more confident.
  const confidence = clamp(1 - (piHigh - piLow) / (2 * predicted), 0.05, 0.95);

  return {
    predicted_return: predicted / base - 1,
    predicted_price: +predicted.toFixed(4),
    confidence: +confidence.toFixed(4),
    pi_low: +piLow.toFixed(4),
    pi_high: +piHigh.toFixed(4),
    factors: {
      paths, seed,
      mu_daily: +mu.toFixed(6), sigma_daily: +sigma.toFixed(6),
      median: +percentile(terminals, 0.5).toFixed(4),
    },
  };
}
