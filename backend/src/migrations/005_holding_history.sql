-- Automatic holding change-log. Every add / update / delete of a holding appends a
-- dated row here, so the value chart can reconstruct the holdings in effect on any
-- past day and show a real month-over-month AVERAGE total asset value. Replaces the
-- earlier manual-snapshot approach (its tables are dropped below).

CREATE TABLE IF NOT EXISTS holding_history (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  portfolio_id   INT NOT NULL,
  holding_id     INT COMMENT 'portfolio_holdings.id this lot refers to (may since be deleted)',
  symbol         VARCHAR(64) NOT NULL,
  account        VARCHAR(64) NOT NULL DEFAULT '',
  shares         DECIMAL(20,6) NOT NULL DEFAULT 0,
  currency       CHAR(3) NOT NULL DEFAULT 'USD',
  action         ENUM('set','delete') NOT NULL DEFAULT 'set',
  effective_date DATE NOT NULL COMMENT 'the date the change took effect',
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_hh_portfolio (portfolio_id, effective_date),
  CONSTRAINT fk_hh_portfolio FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the starting composition from current holdings (only when the log is empty),
-- dating each lot to when it was first added so history begins there.
INSERT INTO holding_history (portfolio_id, holding_id, symbol, account, shares, currency, action, effective_date, created_at)
SELECT portfolio_id, id, symbol, account, shares, currency, 'set', DATE(created_at), created_at
  FROM portfolio_holdings
 WHERE NOT EXISTS (SELECT 1 FROM holding_history);

-- Drop the unused manual-snapshot tables (children first for the FKs).
DROP TABLE IF EXISTS portfolio_snapshot_cash;
DROP TABLE IF EXISTS portfolio_snapshot_holdings;
DROP TABLE IF EXISTS portfolio_snapshots;
