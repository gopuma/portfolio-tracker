import express from 'express';
import { query, getInstrument } from '../db.js';
import { fetchQuotes } from '../services/priceFetcher.js';

export const pricesRouter = express.Router();

/**
 * Batch live quotes for several symbols in one Yahoo call. `?symbols=^GSPC,^DJI,...`
 * Returns { quotes: { SYM: { price, currency, time, market_state, previous_close,
 * change, change_percent } } }. `market_state === 'REGULAR'` means the market is open
 * and `price` is live; otherwise `price` is the latest close. Defined before /:symbol
 * so the literal path isn't swallowed by the symbol param.
 */
pricesRouter.get('/quotes', async (req, res, next) => {
  try {
    const symbols = String(req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
    if (symbols.length === 0) return res.json({ quotes: {} });
    const quotes = await fetchQuotes(symbols);

    // Fall back to the latest stored close for any symbol Yahoo didn't price (offline /
    // throttled) so the cards still render the last known value with market_state 'CLOSED'.
    const missing = symbols.filter(s => quotes[s]?.price == null);
    if (missing.length) {
      const placeholders = missing.map(() => '?').join(',');
      const rows = await query(
        `SELECT i.symbol, i.currency, lp.close_px, lp.trade_date,
                (SELECT close_px FROM prices p WHERE p.instrument_id = i.id AND p.trade_date < lp.trade_date ORDER BY p.trade_date DESC LIMIT 1) AS prev_close
           FROM instruments i
           JOIN v_latest_prices lp ON lp.instrument_id = i.id
          WHERE i.symbol IN (${placeholders})`,
        missing
      );
      for (const r of rows) {
        const price = Number(r.close_px);
        const prev = r.prev_close != null ? Number(r.prev_close) : null;
        quotes[r.symbol] = {
          price, currency: r.currency || null, time: r.trade_date || null,
          market_state: 'CLOSED', previous_close: prev,
          change: prev != null ? price - prev : null,
          change_percent: prev ? ((price - prev) / prev) * 100 : null,
          stored: true,
        };
      }
    }
    res.json({ quotes });
  } catch (e) { next(e); }
});

/** Real-time quote for a symbol straight from Yahoo (not the stored EOD close). */
pricesRouter.get('/:symbol/live', async (req, res, next) => {
  try {
    const symbol = req.params.symbol;
    const quotes = await fetchQuotes([symbol]);
    const hit = quotes[symbol];
    if (!hit || hit.price == null) return res.status(404).json({ error: `No live quote for ${symbol}` });
    res.json({
      symbol,
      price: Number(hit.price),
      currency: hit.currency || null,
      time: hit.time || null,
      market_state: hit.market_state || null,
      previous_close: hit.previous_close ?? null,
      change: hit.change ?? null,
      change_percent: hit.change_percent ?? null,
    });
  } catch (e) { next(e); }
});

pricesRouter.get('/:symbol', async (req, res, next) => {
  try {
    const inst = await getInstrument(req.params.symbol);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });
    const days = Math.min(Number(req.query.days || 90), 1825);
    const rows = await query(
      `SELECT trade_date, open_px, high_px, low_px, close_px, volume
       FROM prices
       WHERE instrument_id = ?
         AND trade_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY trade_date ASC`,
      [inst.id, days]
    );
    res.json({
      symbol: inst.symbol,
      display_name: inst.display_name,
      currency: inst.currency,
      days,
      count: rows.length,
      prices: rows,
    });
  } catch (e) { next(e); }
});
