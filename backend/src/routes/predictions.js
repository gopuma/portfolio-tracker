import express from 'express';
import { query, getInstrument } from '../db.js';
import { predictAndStore } from '../services/prediction.js';

export const predictionsRouter = express.Router();

predictionsRouter.get('/:symbol', async (req, res, next) => {
  try {
    const inst = await getInstrument(req.params.symbol);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });

    // Return the latest prediction if one exists for today; otherwise compute fresh.
    let rows = await query(
      `SELECT * FROM predictions
       WHERE instrument_id = ? AND prediction_date = CURDATE()
       ORDER BY created_at DESC LIMIT 1`,
      [inst.id]
    );
    if (rows.length === 0) {
      const fresh = await predictAndStore(inst);
      return res.json(fresh);
    }
    const p = rows[0];
    res.json({
      ...p,
      factors_json: typeof p.factors_json === 'string'
        ? JSON.parse(p.factors_json) : p.factors_json,
    });
  } catch (e) { next(e); }
});

predictionsRouter.post('/:symbol/recompute', async (req, res, next) => {
  try {
    const inst = await getInstrument(req.params.symbol);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });
    const fresh = await predictAndStore(inst);
    res.json(fresh);
  } catch (e) { next(e); }
});
