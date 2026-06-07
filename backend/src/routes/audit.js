import express from 'express';
import { runAudit } from '../services/auditService.js';

export const auditRouter = express.Router();

/** Independently audit each instrument's values. ?live=1 also cross-checks live Yahoo quotes. */
auditRouter.get('/', async (req, res, next) => {
  try {
    const live = req.query.live === '1' || req.query.live === 'true';
    res.json(await runAudit({ live }));
  } catch (e) { next(e); }
});
