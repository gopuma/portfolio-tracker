import express from 'express';
import { query, getInstrument } from '../db.js';
import { fetchQuotes } from '../services/priceFetcher.js';

export const pricesRouter = express.Router();

/** Real-time quote for a symbol straight from Yahoo (not the stored EOD close). */
pricesRouter.get('/:symbol/live', async (req, res, next) => {
  try {
    const symbol = req.params.symbol;
    const quotes = await fetchQuotes([symbol]);
    const hit = quotes[symbol];
    if (!hit || hit.price == null) return res.status(404).json({ error: `No live quote for ${symbol}` });
    res.json({ symbol, price: Number(hit.price), currency: hit.currency || null, time: hit.time || null });
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
