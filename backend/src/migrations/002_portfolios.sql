-- User-defined portfolios and their holdings.

CREATE TABLE IF NOT EXISTS portfolios (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(255) NOT NULL,
  base_currency CHAR(3) NOT NULL DEFAULT 'USD',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS portfolio_holdings (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  portfolio_id  INT NOT NULL,
  symbol        VARCHAR(64) NOT NULL,
  shares        DECIMAL(20,6) NOT NULL,
  cost_price    DECIMAL(18,4) NOT NULL COMMENT 'per-share cost basis in the holding currency',
  currency      CHAR(3) NOT NULL DEFAULT 'USD',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_portfolio_symbol (portfolio_id, symbol),
  CONSTRAINT fk_holding_portfolio FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
