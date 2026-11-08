import express from 'express';
import { getInstrument, getAllInstruments, query } from '../db.js';
import { fetchAndStorePrices } from '../services/priceDispatcher.js';
import { fetchAndStoreSentiment } from '../services/sentimentService.js';
import { predictAndStore } from '../services/prediction.js';
import { runExclusive } from '../security.js';
import { nextDailyRun } from '../jobs/dailyPriceJob.js';
import { todayLocal } from '../validation.js';

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

// A stored price older than this many calendar days counts as stale: a long weekend plus a
// holiday for markets that close; a day and a bit for crypto, which never does.
const STALE_DAYS = { CRYPTO: 2 };
const STALE_DAYS_DEFAULT = 5;

/**
 * How the automatic refreshes are doing: the last and next nightly run, the last hourly
 * crypto run, and any active instrument whose latest stored price is stale.
 * Defined before /:symbol so the literal path isn't taken for a symbol.
 */
refreshRouter.get('/status', async (_req, res, next) => {
  try {
    const runs = await query(`SELECT name, last_started_at, last_finished_at, last_reason FROM job_runs`);
    const byName = Object.fromEntries(runs.map(r => [r.name, r]));
    const rows = await query(
      `SELECT i.symbol, i.market, DATE_FORMAT(MAX(p.trade_date), '%Y-%m-%d') AS latest,
              DATEDIFF(?, MAX(p.trade_date)) AS age_days
         FROM instruments i LEFT JOIN prices p ON p.instrument_id = i.id
        WHERE i.is_active = 1
        GROUP BY i.id, i.symbol, i.market`,
      [todayLocal()]
    );
    const stale = rows
      .filter(r => r.latest == null || Number(r.age_days) > (STALE_DAYS[r.market] ?? STALE_DAYS_DEFAULT))
      .map(r => ({ symbol: r.symbol, market: r.market, latest: r.latest, age_days: r.age_days == null ? null : Number(r.age_days) }))
      .sort((a, b) => (b.age_days ?? 1e9) - (a.age_days ?? 1e9));
    res.json({
      daily: { ...(byName['daily-refresh'] || {}), next_run: nextDailyRun() },
      crypto: byName['crypto-refresh'] || null,
      instruments: rows.length,
      stale,
    });
  } catch (e) { next(e); }
});

refreshRouter.post('/:symbol', async (req, res, next) => {
  try {
    const inst = await getInstrument(req.params.symbol);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    const days = parseDays(req.query.days);
    await runExclusive(`refresh:${inst.symbol}`, res, async () => res.json(await refreshOne(inst, days)));
  } catch (e) { next(e); }
});

// Refresh everything (sync, may take a while for many tickers).
// Accepts ?days=N to override the default 7-day lookback — useful for
// backfilling longer history (e.g. ?days=1200 for ~3-year return support).
refreshRouter.post('/', async (req, res, next) => {
  try {
    const days = parseDays(req.query.days);
    // One full refresh at a time: each walks every ticker against Yahoo/RSS, so stacking
    // them only multiplies the load and the rate-limit risk.
    await runExclusive('refresh:all', res, async () => {
      const all = await getAllInstruments();
      const results = [];
      for (const inst of all) {
        results.push(await refreshOne(inst, days));
      }
      res.json({ count: results.length, days, results });
    });
  } catch (e) { next(e); }
});
