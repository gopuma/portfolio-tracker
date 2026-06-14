/**
 * Prediction-competition API: leaderboard, model registry, per-symbol forecasts,
 * and a manual backtest trigger. Mounted at /api (see index.js).
 */
import express from 'express';
import { query, getInstrument } from '../db.js';
import { backfill } from '../services/competition/harness.js';
import { leaderboardForSymbol } from '../services/competition/store.js';

export const competitionRouter = express.Router();

const HORIZONS = new Set([5, 30]);
function parseHorizon(raw) {
  const h = Number(raw);
  return HORIZONS.has(h) ? h : 5;
}

// Rank by dir. accuracy, then RMSE skill, then Sharpe; nulls sink to the bottom.
function rankRows(rows) {
  const key = r => [r.directional_accuracy, r.rmse_skill_vs_naive, r.strategy_sharpe]
    .map(v => (v == null || isNaN(v) ? -Infinity : Number(v)));
  return [...rows]
    .sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
      return 0;
    })
    .map((r, i) => ({
      rank: i + 1,
      ...r,
      beats_naive: r.rmse_skill_vs_naive != null && Number(r.rmse_skill_vs_naive) > 0,
    }));
}

/**
 * Ranked leaderboard for one horizon. With ?symbol=XXX the metrics are scoped to that
 * single stock (computed live); without it, the all-stocks aggregate (model_scores).
 */
competitionRouter.get('/leaderboard', async (req, res, next) => {
  try {
    const horizon = parseHorizon(req.query.horizon);
    const symbol = (req.query.symbol || '').trim();

    let rows, windowDays;
    if (symbol) {
      const inst = await getInstrument(symbol);
      if (!inst) return res.status(404).json({ error: 'Instrument not found' });
      windowDays = 180;
      rows = await leaderboardForSymbol(inst.id, horizon, windowDays);
    } else {
      rows = await query(
        `SELECT s.*, m.display_name, m.family, m.is_active
           FROM model_scores s
           JOIN prediction_models m ON m.model_version = s.model_version
          WHERE s.horizon_days = ?`,
        [horizon]
      );
      windowDays = rows[0]?.window_days ?? null;
    }

    const ranked = rankRows(rows);
    res.json({
      horizon,
      symbol: symbol || null,
      window_days: windowDays,
      count: ranked.length,
      models: ranked,
    });
  } catch (e) { next(e); }
});

/** Model registry. */
competitionRouter.get('/models', async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT model_version, family, display_name, is_active, config_json, created_at
         FROM prediction_models ORDER BY family, model_version`
    );
    res.json({ count: rows.length, models: rows });
  } catch (e) { next(e); }
});

/** Latest forecast from every model for a symbol + recent scored history for charting. */
competitionRouter.get('/competition/predictions/:symbol', async (req, res, next) => {
  try {
    const inst = await getInstrument(req.params.symbol);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });
    const horizon = parseHorizon(req.query.horizon);

    const latest = await query(
      `SELECT p.model_version, p.prediction_date, p.base_price, p.predicted_price,
              p.predicted_return, p.confidence, m.display_name, m.family
         FROM predictions p
         JOIN (SELECT model_version, MAX(prediction_date) AS md
                 FROM predictions
                WHERE instrument_id = ? AND horizon_days = ?
                GROUP BY model_version) latest
           ON latest.model_version = p.model_version AND latest.md = p.prediction_date
         JOIN prediction_models m ON m.model_version = p.model_version
        WHERE p.instrument_id = ? AND p.horizon_days = ?
        ORDER BY p.model_version`,
      [inst.id, horizon, inst.id, horizon]
    );

    const history = await query(
      `SELECT model_version, prediction_date, maturity_date,
              predicted_price, realized_price, direction_hit
         FROM prediction_evaluations
        WHERE instrument_id = ? AND horizon_days = ?
        ORDER BY maturity_date DESC
        LIMIT 200`,
      [inst.id, horizon]
    );

    res.json({ symbol: inst.symbol, display_name: inst.display_name, horizon, latest, history });
  } catch (e) { next(e); }
});

/**
 * Manually (re)run the walk-forward backfill + leaderboard refresh. Slow — intended
 * for first-time population or after adding tickers. Body: { window?, mcPaths? }.
 */
competitionRouter.post('/backtest', async (req, res, next) => {
  try {
    const window = Math.min(Math.max(Number(req.body?.window) || 180, 20), 1000);
    const mcPaths = Math.min(Math.max(Number(req.body?.mcPaths) || 2000, 200), 20000);
    const result = await backfill({ window, mcPaths });
    res.json({ ok: true, window, mcPaths, ...result });
  } catch (e) { next(e); }
});
