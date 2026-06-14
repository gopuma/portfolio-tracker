-- Prediction-competition feature.
-- The existing `predictions` table is reused for forecasts (it already carries
-- model_version + horizon_days). We DO NOT ALTER it — prediction-interval bounds
-- (pi_low/pi_high) live in factors_json, and direction derives from the sign of
-- predicted_return. All tables below are idempotent (migrate.js re-runs every file).

-- Registry of competing models (metadata + enable/disable). Mirrored from the
-- JS registry (services/prediction/registry.js) via upsertRegistry().
CREATE TABLE IF NOT EXISTS prediction_models (
  model_version VARCHAR(32) PRIMARY KEY,
  family        ENUM('stat','algo','ml') NOT NULL,
  display_name  VARCHAR(128) NOT NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  config_json   JSON,                                  -- hyperparams, features, seed
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per matured prediction, with realized outcome + errors.
CREATE TABLE IF NOT EXISTS prediction_evaluations (
  id               BIGINT PRIMARY KEY AUTO_INCREMENT,
  prediction_id    BIGINT NOT NULL,
  instrument_id    INT NOT NULL,
  model_version    VARCHAR(32) NOT NULL,
  horizon_days     INT NOT NULL,
  prediction_date  DATE NOT NULL,
  maturity_date    DATE NOT NULL,
  base_price       DECIMAL(18,4) NOT NULL,
  predicted_price  DECIMAL(18,4) NOT NULL,
  realized_price   DECIMAL(18,4) NOT NULL,
  predicted_return DECIMAL(12,6),
  realized_return  DECIMAL(12,6),
  abs_error        DECIMAL(12,6),                       -- |pred_ret - real_ret|
  sq_error         DECIMAL(14,8),                       -- (pred_ret - real_ret)^2
  direction_hit    TINYINT(1),                          -- 1 if signs matched
  in_interval      TINYINT(1),                          -- realized within [pi_low, pi_high]
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_eval (prediction_id),
  KEY idx_eval_model (model_version, horizon_days, maturity_date),
  CONSTRAINT fk_eval_pred FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Materialized leaderboard: aggregate Section-6 metrics per model x horizon over the
-- eval window. Refreshed by the evaluation step (refreshLeaderboard()).
CREATE TABLE IF NOT EXISTS model_scores (
  model_version        VARCHAR(32) NOT NULL,
  horizon_days         INT NOT NULL,
  window_days          INT NOT NULL,
  n_samples            INT NOT NULL DEFAULT 0,
  directional_accuracy DECIMAL(6,4),                    -- [0,1]
  mae_return           DECIMAL(12,6),
  rmse_return          DECIMAL(12,6),
  mape_price           DECIMAL(12,6),
  rmse_skill_vs_naive  DECIMAL(12,6),                   -- 1 - rmse_model/rmse_naive
  strategy_return      DECIMAL(12,6),                   -- realized return of acting on direction
  strategy_sharpe      DECIMAL(12,6),
  buyhold_return       DECIMAL(12,6),
  coverage             DECIMAL(6,4),                    -- predictions made / opportunities
  updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (model_version, horizon_days)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
