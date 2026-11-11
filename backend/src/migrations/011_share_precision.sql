-- Share counts to 8 decimal places, bitcoin's own unit (1 satoshi = 0.00000001 BTC), so a
-- fractional coin is stored exactly. Widened by the same 2 digits on the left, so every
-- existing value still fits. MODIFY is idempotent: re-running leaves the columns as they are.

ALTER TABLE transactions       MODIFY shares DECIMAL(26,8) NOT NULL;
ALTER TABLE portfolio_holdings MODIFY shares DECIMAL(22,8) NOT NULL;
ALTER TABLE holding_history    MODIFY shares DECIMAL(22,8) NOT NULL DEFAULT 0;
