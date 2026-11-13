-- Cash dividends per share, by ex-dividend date, in the instrument's own currency. Filled
-- from Yahoo's dividend events on every price fetch (priceFetcher), so the daily job keeps
-- it current and a Backfill reaches further back. Used for the actual year-to-date profit,
-- which counts the dividends a holding paid while it was held.

CREATE TABLE IF NOT EXISTS dividends (
  instrument_id INT NOT NULL,
  ex_date       DATE NOT NULL,
  amount        DECIMAL(18,6) NOT NULL COMMENT 'per share, in the instrument currency, before tax',
  PRIMARY KEY (instrument_id, ex_date),
  CONSTRAINT fk_dividends_instrument FOREIGN KEY (instrument_id) REFERENCES instruments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
