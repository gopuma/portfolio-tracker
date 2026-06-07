-- Portfolio Tracker schema
-- Run with: npm run migrate

CREATE TABLE IF NOT EXISTS instruments (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  symbol        VARCHAR(64) NOT NULL UNIQUE,
  display_name  VARCHAR(255) NOT NULL,
  asset_class   ENUM('STOCK','ETF','BOND_ETF','COMMODITY','CASH','CRYPTO','REIT') NOT NULL DEFAULT 'ETF',
  currency      CHAR(3) NOT NULL DEFAULT 'USD',
  market        VARCHAR(16) NOT NULL DEFAULT 'US',
  category      VARCHAR(64),
  notes         TEXT,
  is_active     TINYINT(1) DEFAULT 1,
  watchlist     TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1 = shown on the Overview market tables; 0 = tracked only for portfolios',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS prices (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  instrument_id INT NOT NULL,
  trade_date    DATE NOT NULL,
  open_px       DECIMAL(18,4),
  high_px       DECIMAL(18,4),
  low_px        DECIMAL(18,4),
  close_px      DECIMAL(18,4) NOT NULL,
  volume        BIGINT,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_instrument_date (instrument_id, trade_date),
  INDEX idx_date (trade_date),
  CONSTRAINT fk_prices_instrument FOREIGN KEY (instrument_id) REFERENCES instruments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sentiment_scores (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  instrument_id   INT NOT NULL,
  score_date      DATE NOT NULL,
  score           DECIMAL(5,4) NOT NULL COMMENT 'range [-1, 1]',
  headline_count  INT DEFAULT 0,
  source          VARCHAR(64) DEFAULT 'rss-mixed',
  headlines_json  JSON,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_instrument_date_source (instrument_id, score_date, source),
  CONSTRAINT fk_sent_instrument FOREIGN KEY (instrument_id) REFERENCES instruments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS predictions (
  id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
  instrument_id       INT NOT NULL,
  prediction_date     DATE NOT NULL,
  horizon_days        INT NOT NULL DEFAULT 5,
  base_price          DECIMAL(18,4) NOT NULL,
  predicted_price     DECIMAL(18,4) NOT NULL,
  predicted_return    DECIMAL(8,4),
  confidence          DECIMAL(5,4),
  composite_signal    DECIMAL(6,4),
  trend_signal        DECIMAL(6,4),
  momentum_signal     DECIMAL(6,4),
  sentiment_signal    DECIMAL(6,4),
  value_signal        DECIMAL(6,4),
  model_version       VARCHAR(32) DEFAULT 'heuristic-v1',
  factors_json        JSON,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_pred (instrument_id, prediction_date, horizon_days, model_version),
  CONSTRAINT fk_pred_instrument FOREIGN KEY (instrument_id) REFERENCES instruments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Latest-price view for fast portfolio reads
CREATE OR REPLACE VIEW v_latest_prices AS
SELECT p.instrument_id, p.trade_date, p.close_px, p.volume
FROM prices p
JOIN (
  SELECT instrument_id, MAX(trade_date) AS max_date
  FROM prices
  GROUP BY instrument_id
) m ON m.instrument_id = p.instrument_id AND m.max_date = p.trade_date;
