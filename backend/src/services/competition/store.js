/**
 * Database I/O for the prediction competition. Keeps all SQL in one place so the
 * harness and routes stay readable.
 */
import { pool, query } from '../../db.js';
import { scorecard, rmseReturn } from './metrics.js';

const num = (v, d = 4) => (v == null || isNaN(v) ? null : Number(Number(v).toFixed(d)));

/** Watchlist instruments we predict on — same filter the analytics page uses. */
export function getUniverse() {
  return query(
    `SELECT id, symbol, display_name, market, currency
       FROM instruments
      WHERE is_active = 1 AND watchlist = 1 AND market NOT IN ('FX', 'INDEX')
      ORDER BY market, symbol`
  );
}

/** Full chronological close series for an instrument. */
export async function loadSeries(instrumentId) {
  const rows = await query(
    `SELECT trade_date, close_px FROM prices WHERE instrument_id = ? ORDER BY trade_date ASC`,
    [instrumentId]
  );
  return {
    dates: rows.map(r => (r.trade_date instanceof Date ? r.trade_date.toISOString() : String(r.trade_date)).slice(0, 10)),
    closes: rows.map(r => Number(r.close_px)),
  };
}

/** Sentiment scores (sorted) for point-in-time 7-day averaging during backfill. */
export async function loadSentiment(instrumentId) {
  const rows = await query(
    `SELECT score_date, score FROM sentiment_scores WHERE instrument_id = ? ORDER BY score_date ASC`,
    [instrumentId]
  );
  return rows.map(r => ({
    date: (r.score_date instanceof Date ? r.score_date.toISOString() : String(r.score_date)).slice(0, 10),
    score: Number(r.score),
  }));
}

/**
 * Insert/update a prediction row, returning its id (uses the LAST_INSERT_ID trick
 * so we get the existing id back on a duplicate key, needed for the evaluation FK).
 */
export async function upsertPrediction(row, db = pool) {
  const [res] = await db.execute(
    `INSERT INTO predictions
       (instrument_id, prediction_date, horizon_days, base_price, predicted_price,
        predicted_return, confidence, model_version, factors_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       base_price = VALUES(base_price), predicted_price = VALUES(predicted_price),
       predicted_return = VALUES(predicted_return), confidence = VALUES(confidence),
       factors_json = VALUES(factors_json)`,
    [
      row.instrument_id, row.prediction_date, row.horizon_days,
      num(row.base_price), num(row.predicted_price), num(row.predicted_return),
      num(row.confidence), row.model_version, JSON.stringify(row.factors || {}),
    ]
  );
  return res.insertId;
}

export async function upsertEvaluation(e, db = pool) {
  await db.execute(
    `INSERT INTO prediction_evaluations
       (prediction_id, instrument_id, model_version, horizon_days, prediction_date,
        maturity_date, base_price, predicted_price, realized_price,
        predicted_return, realized_return, abs_error, sq_error, direction_hit, in_interval)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       realized_price = VALUES(realized_price), realized_return = VALUES(realized_return),
       abs_error = VALUES(abs_error), sq_error = VALUES(sq_error),
       direction_hit = VALUES(direction_hit), in_interval = VALUES(in_interval)`,
    [
      e.prediction_id, e.instrument_id, e.model_version, e.horizon_days, e.prediction_date,
      e.maturity_date, num(e.base_price), num(e.predicted_price), num(e.realized_price),
      num(e.predicted_return, 6), num(e.realized_return, 6), num(e.abs_error, 6),
      num(e.sq_error, 8), e.direction_hit ? 1 : 0, e.in_interval == null ? null : (e.in_interval ? 1 : 0),
    ]
  );
}

/**
 * Live per-stock leaderboard: the same Section-6 metrics as the aggregate board,
 * but computed on the fly from prediction_evaluations for a single instrument (the
 * materialized model_scores table only holds the all-stocks aggregate). Returns one
 * row per model that has scored predictions for this stock at the given horizon.
 */
export async function leaderboardForSymbol(instrumentId, horizon, windowDays = 180) {
  const calCutoffDays = Math.round(windowDays * 1.45);
  const rows = await query(
    `SELECT model_version, predicted_return, realized_return,
            predicted_price, realized_price, direction_hit
       FROM prediction_evaluations
      WHERE instrument_id = ? AND horizon_days = ?
        AND prediction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    [instrumentId, horizon, calCutoffDays]
  );

  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.model_version)) groups.set(r.model_version, []);
    groups.get(r.model_version).push({
      predicted_return: Number(r.predicted_return),
      realized_return: Number(r.realized_return),
      predicted_price: Number(r.predicted_price),
      realized_price: Number(r.realized_price),
      direction_hit: r.direction_hit,
    });
  }

  const naive = rmseReturn(groups.get('naive-rw-v1') || []);
  const meta = await query(`SELECT model_version, display_name, family, is_active FROM prediction_models`);
  const metaMap = Object.fromEntries(meta.map(m => [m.model_version, m]));
  let maxN = 0;
  for (const e of groups.values()) maxN = Math.max(maxN, e.length);

  const out = [];
  for (const [mv, evals] of groups) {
    const s = scorecard(evals, naive);
    const m = metaMap[mv] || {};
    out.push({
      model_version: mv, horizon_days: horizon, window_days: windowDays, ...s,
      coverage: maxN ? evals.length / maxN : null,
      display_name: m.display_name || mv, family: m.family || '', is_active: m.is_active ?? 1,
    });
  }
  return out;
}

/**
 * Recompute the model_scores leaderboard from prediction_evaluations over a rolling
 * window. `windowDays` is in trading days; we approximate the calendar cutoff.
 */
export async function refreshLeaderboard(windowDays = 180) {
  const calCutoffDays = Math.round(windowDays * 1.45); // ~trading→calendar
  const rows = await query(
    `SELECT model_version, horizon_days, predicted_return, realized_return,
            predicted_price, realized_price, direction_hit
       FROM prediction_evaluations
      WHERE prediction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    [calCutoffDays]
  );

  // Group by model_version × horizon.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.model_version}|${r.horizon_days}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      predicted_return: Number(r.predicted_return),
      realized_return: Number(r.realized_return),
      predicted_price: Number(r.predicted_price),
      realized_price: Number(r.realized_price),
      direction_hit: r.direction_hit,
    });
  }

  // Naive RMSE per horizon (baseline for the skill score).
  const naiveRmse = {};
  for (const h of [5, 30]) naiveRmse[h] = rmseReturn(groups.get(`naive-rw-v1|${h}`) || []);

  // Max sample count per horizon (for relative coverage).
  const maxN = {};
  for (const [key, evals] of groups) {
    const h = Number(key.split('|')[1]);
    maxN[h] = Math.max(maxN[h] || 0, evals.length);
  }

  for (const [key, evals] of groups) {
    const [model_version, hStr] = key.split('|');
    const horizon = Number(hStr);
    const s = scorecard(evals, naiveRmse[horizon]);
    const coverage = maxN[horizon] ? evals.length / maxN[horizon] : null;
    await pool.execute(
      `INSERT INTO model_scores
         (model_version, horizon_days, window_days, n_samples, directional_accuracy,
          mae_return, rmse_return, mape_price, rmse_skill_vs_naive,
          strategy_return, strategy_sharpe, buyhold_return, coverage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         window_days = VALUES(window_days), n_samples = VALUES(n_samples),
         directional_accuracy = VALUES(directional_accuracy), mae_return = VALUES(mae_return),
         rmse_return = VALUES(rmse_return), mape_price = VALUES(mape_price),
         rmse_skill_vs_naive = VALUES(rmse_skill_vs_naive),
         strategy_return = VALUES(strategy_return), strategy_sharpe = VALUES(strategy_sharpe),
         buyhold_return = VALUES(buyhold_return), coverage = VALUES(coverage)`,
      [
        model_version, horizon, windowDays, s.n_samples,
        num(s.directional_accuracy), num(s.mae_return, 6), num(s.rmse_return, 6),
        num(s.mape_price, 6), num(s.rmse_skill_vs_naive, 6),
        num(s.strategy_return, 6), num(s.strategy_sharpe, 6), num(s.buyhold_return, 6),
        num(coverage),
      ]
    );
  }
  return { models_scored: groups.size };
}
