import express from 'express';
import { query, getInstrument } from '../db.js';
import { fetchAndStoreSentiment } from '../services/sentimentService.js';

export const sentimentRouter = express.Router();

sentimentRouter.get('/:symbol', async (req, res, next) => {
  try {
    const inst = await getInstrument(req.params.symbol);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });

    const days = Number(req.query.days || 7);
    const rows = await query(
      `SELECT score_date, score, headline_count, headlines_json, source
       FROM sentiment_scores
       WHERE instrument_id = ?
         AND score_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY score_date DESC`,
      [inst.id, days]
    );

    res.json({
      symbol: inst.symbol,
      days,
      rolling_avg: rows.length
        ? rows.reduce((a, r) => a + Number(r.score), 0) / rows.length
        : null,
      records: rows,
    });
  } catch (e) { next(e); }
});

// POST /api/sentiment/:symbol/refresh — fetch fresh headlines and recompute today's score
sentimentRouter.post('/:symbol/refresh', async (req, res, next) => {
  try {
    const inst = await getInstrument(req.params.symbol);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });
    const result = await fetchAndStoreSentiment(inst);
    res.json(result);
  } catch (e) { next(e); }
});
