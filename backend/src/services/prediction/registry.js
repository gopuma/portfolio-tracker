/**
 * Model registry — the single source of truth for the prediction competition.
 * Each entry pairs metadata (mirrored into the `prediction_models` table) with the
 * pure predict(ctx, horizon, config) function. Adding a competitor = adding one
 * entry here. Changing a model's logic ⇒ bump model_version (never silently mutate
 * a ranked model), per the template's versioning rule.
 */
import { pool, query } from '../../db.js';
import { predict as naiveRw } from './models/naiveRw.js';
import { predict as drift } from './models/drift.js';
import { predict as arima } from './models/arima.js';
import { predict as ets } from './models/ets.js';
import { predict as ridge } from './models/ridge.js';
import { predict as monteCarlo } from './models/monteCarlo.js';
import { predict as heuristic } from './models/heuristic.js';

export const HORIZONS = [5, 30];

export const MODELS = [
  {
    model_version: 'naive-rw-v1', family: 'stat', display_name: 'Naive Random Walk',
    min_history: 2, config: { seed: 0 }, predict: naiveRw,
  },
  {
    model_version: 'drift-v1', family: 'stat', display_name: 'Random Walk + Drift',
    min_history: 30, config: { window: 252, seed: 7 }, predict: drift,
  },
  {
    model_version: 'arima-v1', family: 'stat', display_name: 'ARIMA(p,1,0)-lite',
    min_history: 70, config: { p: 2, window: 252, seed: 7 }, predict: arima,
  },
  {
    model_version: 'ets-v1', family: 'stat', display_name: 'Holt Exp. Smoothing',
    min_history: 30, config: { alpha: 0.3, beta: 0.1, window: 252, seed: 7 }, predict: ets,
  },
  {
    model_version: 'ridge-v1', family: 'ml', display_name: 'Ridge Regression (TA)',
    min_history: 120, config: { alpha: 1.0, window: 252, seed: 7 }, predict: ridge,
  },
  {
    model_version: 'montecarlo-v1', family: 'stat', display_name: 'Monte-Carlo GBM',
    min_history: 60, config: { paths: 10000, window: 252, seed: 7 }, predict: monteCarlo,
  },
  {
    model_version: 'heuristic-v1', family: 'algo', display_name: 'Heuristic Ensemble',
    min_history: 60, config: { weights: { trend: 0.3, momentum: 0.25, sentiment: 0.25, value: 0.2 }, seed: 7 },
    predict: heuristic,
  },
  // Remote models: computed by the Python sidecar (Phase 2). They share the same TA
  // features as ridge-v1 so the boosting comparison is apples-to-apples. `remote: true`
  // means the harness calls the sidecar in batch instead of a local predict().
  {
    model_version: 'gbm-v1', family: 'ml', display_name: 'XGBoost (TA)',
    min_history: 120, remote: true, sidecarModel: 'xgboost',
    config: { n_estimators: 200, max_depth: 3, learning_rate: 0.05, subsample: 0.8, train: 252, seed: 7 },
    predict: remoteStub('gbm-v1'),
  },
  {
    model_version: 'gbm-lgbm-v1', family: 'ml', display_name: 'LightGBM (TA)',
    min_history: 120, remote: true, sidecarModel: 'lightgbm',
    config: { n_estimators: 200, max_depth: 3, learning_rate: 0.05, subsample: 0.8, train: 252, seed: 7 },
    predict: remoteStub('gbm-lgbm-v1'),
  },
];

// Remote models have no synchronous predict() — they're driven by the sidecar batch
// path in the harness. This guards against accidental local use.
function remoteStub(version) {
  return () => { throw new Error(`${version} is a remote model — use the sidecar batch path`); };
}

export function getModel(version) {
  return MODELS.find(m => m.model_version === version) || null;
}

/** Mirror the code registry into prediction_models (preserving manual is_active). */
export async function upsertRegistry() {
  for (const m of MODELS) {
    await pool.execute(
      `INSERT INTO prediction_models (model_version, family, display_name, config_json)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE family = VALUES(family),
         display_name = VALUES(display_name), config_json = VALUES(config_json)`,
      [m.model_version, m.family, m.display_name, JSON.stringify(m.config)]
    );
  }
}

/** Active model defs = registry entries whose DB row has is_active = 1. */
export async function getActiveModels() {
  await upsertRegistry();
  const rows = await query(`SELECT model_version FROM prediction_models WHERE is_active = 1`);
  const active = new Set(rows.map(r => r.model_version));
  return MODELS.filter(m => active.has(m.model_version));
}
