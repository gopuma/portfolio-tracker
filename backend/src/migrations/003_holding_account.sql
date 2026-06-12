-- Allow the same ticker to be held several times in one portfolio (e.g. the same
-- stock across different brokerage accounts). Adds an optional `account` label and
-- changes holding uniqueness from (portfolio_id, symbol) to (portfolio_id, symbol, account).
-- Idempotent: each step is guarded via information_schema so re-running migrate is safe.

SET @add_col := IF(
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'portfolio_holdings' AND column_name = 'account') = 0,
  'ALTER TABLE portfolio_holdings ADD COLUMN account VARCHAR(64) NOT NULL DEFAULT '''' AFTER symbol',
  'SELECT 1');
PREPARE s1 FROM @add_col;
EXECUTE s1;
DEALLOCATE PREPARE s1;

-- Add the new unique key BEFORE dropping the old one: it also leads with
-- portfolio_id, so the foreign key (fk_holding_portfolio) keeps a usable index.
SET @add_new := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'portfolio_holdings' AND index_name = 'uniq_portfolio_symbol_account') = 0,
  'ALTER TABLE portfolio_holdings ADD UNIQUE KEY uniq_portfolio_symbol_account (portfolio_id, symbol, account)',
  'SELECT 1');
PREPARE s2 FROM @add_new;
EXECUTE s2;
DEALLOCATE PREPARE s2;

SET @drop_old := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'portfolio_holdings' AND index_name = 'uniq_portfolio_symbol') > 0,
  'ALTER TABLE portfolio_holdings DROP INDEX uniq_portfolio_symbol',
  'SELECT 1');
PREPARE s3 FROM @drop_old;
EXECUTE s3;
DEALLOCATE PREPARE s3;
