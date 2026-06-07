import express from 'express';
import { getInstrument, getAllInstruments } from '../db.js';
import { fetchAndStorePrices } from '../services/priceDispatcher.js';
import { fetchAndStoreSentiment } from '../services/sentimentService.js';
import { predictAndStore } from '../services/prediction.js';

export const refreshRouter = express.Router();

const DEFAULT_DAYS = 7;
const MAX_DAYS = 4000; // ~11 years, plenty of headroom for long backfills

function parseDays(raw) {
  if (raw == null || raw === '') return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(Math.floor(n), MAX_DAYS);
}

async function refreshOne(inst, days = DEFAULT_DAYS) {
  const result = { symbol: inst.symbol, days };
  try { result.prices    = await fetchAndStorePrices(inst, days); }
  catch (e) { result.prices_error = e.message; }
  try { result.sentiment = await fetchAndStoreSentiment(inst); }
  catch (e) { result.sentiment_error = e.message; }
  try { result.prediction = await predictAndStore(inst); }
  catch (e) { result.prediction_error = e.message; }
  return result;
}

refreshRouter.post('/:symbol', async (req, res, next) => {
  try {
    const inst = await getInstrument(req.params.symbol);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    const days = parseDays(req.query.days);
    res.json(await refreshOne(inst, days));
  } catch (e) { next(e); }
});

// Refresh everything (sync, may take a while for many tickers).
// Accepts ?days=N to override the default 7-day lookback — useful for
// backfilling longer history (e.g. ?days=1200 for ~3-year return support).
refreshRouter.post('/', async (req, res, next) => {
  try {
    const days = parseDays(req.query.days);
    const all = await getAllInstruments();
    const results = [];
    for (const inst of all) {
      results.push(await refreshOne(inst, days));
    }
    res.json({ count: results.length, days, results });
  } catch (e) { next(e); }
});
