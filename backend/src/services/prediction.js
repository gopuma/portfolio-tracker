/**
 * Heuristic short-term price prediction ensemble.
 *
 * Combines 4 explainable factors, each producing a signal in [-1, +1]:
 *   1. Trend (SMA cross):   20-day SMA vs 50-day SMA, normalized
 *   2. Momentum (RSI):      14-day RSI;   <30 bullish, >70 bearish
 *   3. Sentiment:           avg of last 7 days of sentiment_scores
 *   4. Value (mean-reversion proxy): z-score of close vs 200-day mean (inverted)
 *
 * Composite = weighted average of factors.
 * 5-day price target = base_price * (1 + composite * vol_scale)
 *   where vol_scale = min(2.5%, 30-day daily vol * sqrt(5))
 * Confidence = 1 - dispersion(factor signals)  (more agreement = more confident)
 *
 * Returns the row inserted into `predictions`.
 */
import { query, pool } from '../db.js';

const HORIZON_DAYS = 5;
const MODEL_VERSION = 'heuristic-v1';
const WEIGHTS = { trend: 0.30, momentum: 0.25, sentiment: 0.25, value: 0.20 };

// These technical-indicator helpers are exported and reused by the prediction
// competition (services/prediction/features.js and the heuristic-v1 adapter), so
// there is one source of truth for the math.
export function sma(arr, n) {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

export function stdev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

export function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

export function clamp(x, lo = -1, hi = 1) { return Math.max(lo, Math.min(hi, x)); }

function trendSignal(closes) {
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  if (sma20 == null || sma50 == null) return 0;
  // Normalize the gap by sma50, then squash with tanh-like clamp
  const gap = (sma20 - sma50) / sma50;
  return clamp(gap * 20);  // ±5% gap → ±1 signal
}

function momentumSignal(closes) {
  const r = rsi(closes, 14);
  if (r == null) return 0;
  // RSI 30 → +1 (oversold, bullish), RSI 70 → -1 (overbought, bearish), RSI 50 → 0
  return clamp((50 - r) / 20);
}

function valueSignal(closes) {
  // z-score vs 200-day mean; high price (overvalued) → negative signal
  const window = closes.slice(-200);
  if (window.length < 60) return 0;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const sd = stdev(window);
  if (sd === 0) return 0;
  const z = (closes[closes.length - 1] - mean) / sd;
  return clamp(-z / 2); // z=+2 → -1 (rich), z=-2 → +1 (cheap)
}

function dailyVolatility(closes, window = 30) {
  if (closes.length < window + 1) return 0.02;
  const rets = [];
  for (let i = closes.length - window; i < closes.length; i++) {
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  return stdev(rets);
}

function confidenceFrom(signals) {
  // More agreement (lower dispersion) = higher confidence
  const vals = Object.values(signals);
  const dispersion = stdev(vals);
  return clamp(1 - dispersion, 0, 1);
}

/**
 * Pure heuristic-v1 forecast from a closes series + a 7-day sentiment average.
 * No DB access — point-in-time safe, so it can be reused by the prediction
 * competition's walk-forward harness at any horizon. `predictAndStore` below
 * wraps this for the existing Overview behavior (horizon 5).
 */
export function computeHeuristic(closes, sentAvg = 0, horizon = HORIZON_DAYS) {
  const basePrice = closes[closes.length - 1];
  const signals = {
    trend:     trendSignal(closes),
    momentum:  momentumSignal(closes),
    sentiment: clamp(sentAvg),
    value:     valueSignal(closes),
  };
  const composite =
      signals.trend     * WEIGHTS.trend
    + signals.momentum  * WEIGHTS.momentum
    + signals.sentiment * WEIGHTS.sentiment
    + signals.value     * WEIGHTS.value;

  const vol = dailyVolatility(closes, 30);
  // Same shape as before: cap the per-horizon move at ~7.5% (0.025*3).
  const volScale = Math.min(0.025 * 3, vol * Math.sqrt(horizon) * 3);
  const predictedReturn = composite * volScale;
  const predictedPrice  = +(basePrice * (1 + predictedReturn)).toFixed(4);
  const confidence = +confidenceFrom(signals).toFixed(4);

  return {
    base_price: basePrice,
    predicted_return: predictedReturn,
    predicted_price: predictedPrice,
    confidence,
    composite,
    signals,
    factors: {
      weights: WEIGHTS,
      raw_signals: signals,
      vol_30d_daily: +vol.toFixed(4),
      vol_scale_used: +volScale.toFixed(4),
    },
  };
}

export async function predictAndStore(instrument) {
  // Pull 1 year of close prices
  const priceRows = await query(
    `SELECT trade_date, close_px FROM prices
     WHERE instrument_id = ?
     ORDER BY trade_date ASC`,
    [instrument.id]
  );
  if (priceRows.length < 25) {
    throw new Error(`Not enough price history for ${instrument.symbol} (have ${priceRows.length}, need 25+)`);
  }
  const closes = priceRows.map(r => Number(r.close_px));

  // Latest sentiment (rolling 7-day avg)
  const sentRows = await query(
    `SELECT score FROM sentiment_scores
     WHERE instrument_id = ? AND score_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`,
    [instrument.id]
  );
  const sentAvg = sentRows.length
    ? sentRows.reduce((a, r) => a + Number(r.score), 0) / sentRows.length
    : 0;

  const h = computeHeuristic(closes, sentAvg, HORIZON_DAYS);
  const basePrice = h.base_price;
  const signals = h.signals;
  const composite = h.composite;
  const predictedReturn = h.predicted_return;
  const predictedPrice = h.predicted_price;
  const confidence = h.confidence;
  const factors = { ...h.factors, sentiment_records: sentRows.length };

  const today = new Date().toISOString().slice(0, 10);
  await pool.execute(
    `INSERT INTO predictions
       (instrument_id, prediction_date, horizon_days, base_price, predicted_price,
        predicted_return, confidence, composite_signal,
        trend_signal, momentum_signal, sentiment_signal, value_signal,
        model_version, factors_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       base_price=VALUES(base_price), predicted_price=VALUES(predicted_price),
       predicted_return=VALUES(predicted_return), confidence=VALUES(confidence),
       composite_signal=VALUES(composite_signal),
       trend_signal=VALUES(trend_signal), momentum_signal=VALUES(momentum_signal),
       sentiment_signal=VALUES(sentiment_signal), value_signal=VALUES(value_signal),
       factors_json=VALUES(factors_json)`,
    [
      instrument.id, today, HORIZON_DAYS, basePrice, predictedPrice,
      predictedReturn.toFixed(4), confidence, composite.toFixed(4),
      signals.trend.toFixed(4), signals.momentum.toFixed(4),
      signals.sentiment.toFixed(4), signals.value.toFixed(4),
      MODEL_VERSION, JSON.stringify(factors),
    ]
  );

  return {
    symbol: instrument.symbol,
    prediction_date: today,
    horizon_days: HORIZON_DAYS,
    base_price: basePrice,
    predicted_price: predictedPrice,
    predicted_return: predictedReturn,
    confidence,
    composite_signal: composite,
    signals,
    factors_json: factors,
    model_version: MODEL_VERSION,
  };
}
