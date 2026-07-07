-- Fundamentals research: cached financial statements (income / balance / cash-flow)
-- and forward estimates (analyst consensus + ML model), fetched on demand from Yahoo
-- and cached with a TTL. Figures are stored in the company's native reporting currency;
-- FX conversion to a common currency happens at read time (period-average rate).

CREATE TABLE IF NOT EXISTS fundamentals (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  instrument_id      INT NOT NULL,
  freq               ENUM('annual','quarterly') NOT NULL,
  fiscal_date        DATE NOT NULL,
  currency           CHAR(3) NULL,
  revenue            DECIMAL(24,2) NULL,
  cost_of_revenue    DECIMAL(24,2) NULL,
  gross_profit       DECIMAL(24,2) NULL,
  operating_income   DECIMAL(24,2) NULL,
  net_income         DECIMAL(24,2) NULL,
  eps_diluted        DECIMAL(18,4) NULL,
  total_assets       DECIMAL(24,2) NULL,
  total_liabilities  DECIMAL(24,2) NULL,
  total_equity       DECIMAL(24,2) NULL,
  cash_sti           DECIMAL(24,2) NULL,
  total_debt         DECIMAL(24,2) NULL,
  operating_cf       DECIMAL(24,2) NULL,
  capex              DECIMAL(24,2) NULL,
  fcf                DECIMAL(24,2) NULL,
  shares             DECIMAL(24,2) NULL,
  fetched_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_fundamentals (instrument_id, freq, fiscal_date),
  CONSTRAINT fk_fundamentals_instrument FOREIGN KEY (instrument_id) REFERENCES instruments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS estimates (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  instrument_id  INT NOT NULL,
  period_label   VARCHAR(8) NOT NULL COMMENT "'0q','+1q','0y','+1y'",
  period_end     DATE NULL,
  currency       CHAR(3) NULL,
  revenue_avg    DECIMAL(24,2) NULL,
  eps_avg        DECIMAL(18,4) NULL,
  num_analysts   INT NULL,
  source         ENUM('consensus','model') NOT NULL DEFAULT 'consensus',
  as_of          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_estimates (instrument_id, period_label, source),
  CONSTRAINT fk_estimates_instrument FOREIGN KEY (instrument_id) REFERENCES instruments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
