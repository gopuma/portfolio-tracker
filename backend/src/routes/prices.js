import express from 'express';
import { query, getInstrument } from '../db.js';

export const pricesRouter = express.Router();

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
