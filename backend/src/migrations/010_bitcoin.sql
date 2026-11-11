-- Bitcoin, holdable in a portfolio like any other asset: in won at Upbit's price, or in
-- dollars at the global price. watchlist = 0 keeps them out of the Overview market tables,
-- analytics and the prediction competition; the Overview has its own bitcoin panel.
-- INSERT IGNORE: safe to re-run, and leaves the rows alone once they exist.

INSERT IGNORE INTO instruments (symbol, display_name, asset_class, currency, market, category, notes, watchlist)
VALUES
  ('UPBIT-KRW-BTC', 'Bitcoin (Upbit, KRW)', 'CRYPTO', 'KRW', 'CRYPTO', 'bitcoin',
   'Upbit KRW-BTC daily candles (api.upbit.com), in won. Includes the Korean premium over the global price.', 0),
  ('BTC-USD', 'Bitcoin (global, USD)', 'CRYPTO', 'USD', 'CRYPTO', 'bitcoin',
   'Yahoo Finance BTC-USD, the global price in dollars.', 0);
