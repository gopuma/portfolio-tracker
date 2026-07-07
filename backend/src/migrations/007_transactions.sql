-- Transaction ledger: the source of truth for portfolio composition and cost basis.
-- Current holdings, cash balances, and the value chart are all DERIVED from these rows
-- (average-cost method). Securities use side buy/sell; cash uses deposit/withdraw
-- (stored as symbol 'CASH:<CCY>', shares = amount, price = 1). Cash is managed MANUALLY —
-- buys and sells do NOT move cash; only deposit/withdraw change a cash balance.

CREATE TABLE IF NOT EXISTS transactions (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  portfolio_id  INT NOT NULL,
  symbol        VARCHAR(64) NOT NULL,
  account       VARCHAR(64) NOT NULL DEFAULT '',
  side          ENUM('buy','sell','deposit','withdraw') NOT NULL,
  shares        DECIMAL(24,6) NOT NULL,
  price         DECIMAL(18,4) NOT NULL DEFAULT 1,
  currency      CHAR(3) NOT NULL DEFAULT 'USD',
  trade_date    DATE NOT NULL COMMENT 'the real (backdatable) trade date',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_txn_portfolio (portfolio_id, trade_date),
  CONSTRAINT fk_txn_portfolio FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
