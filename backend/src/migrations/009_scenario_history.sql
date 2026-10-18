-- Long daily history for the stress test's historical replay (back to 1985), kept apart
-- from `prices` so decades of extra rows never reach the charts, analytics or prediction
-- models that read that table. Loaded by scripts/load-scenario-history.js.
--
-- `series` is a Yahoo symbol (value = adjusted close: splits and dividends folded in),
-- a FRED series id prefixed 'FRED:' (value as published), or 'TBILL' — a total-return
-- index built from the 3-month T-bill rate.
CREATE TABLE IF NOT EXISTS scenario_history (
  series     VARCHAR(32)   NOT NULL,
  trade_date DATE          NOT NULL,
  value      DECIMAL(24,8) NOT NULL,
  PRIMARY KEY (series, trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
