import cron from 'node-cron';
import { getAllInstruments, query } from '../db.js';
import { fetchAndStorePrices } from '../services/priceDispatcher.js';
import { fetchAndStoreSentiment } from '../services/sentimentService.js';
import { predictAndStore } from '../services/prediction.js';
import { runAudit } from '../services/auditService.js';
import { runDailyPredictions, runEvaluation } from '../services/competition/harness.js';
import { todayLocal } from '../validation.js';

// 06:30 KST, Tue–Sat: after the US close in both DST regimes (16:00 ET is 05:00 KST on
// EDT, 06:00 KST on EST), so the run stores settled closes rather than a partial bar for
// a session still in progress. Tue–Sat because a Friday US session closes Sat 05:00 KST.
const CRON = process.env.CRON_DAILY_REFRESH || '30 6 * * 2-6';
const TIMEZONE = 'Asia/Seoul';
const JOB_NAME = 'daily-refresh';

// How far back the catch-up check looks for a scheduled run it may have missed. Each run fetches back
// to every instrument's last stored price (see refreshDays), so one catch-up run fills the
// gap however long the backend was off.
const CATCH_UP_LOOKBACK_DAYS = 7;
// A run that started but never finished (the backend was stopped or restarted mid-run)
// counts as missed once it is this old; younger than that it may still be going.
const STALE_RUN_MS = 30 * 60 * 1000;
// node-cron never replays a firing that came due while the computer slept, so besides at
// startup the catch-up check also runs on this interval; after a wake it fires within this.
const CATCH_UP_CHECK_MS = 10 * 60 * 1000;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// How far back each run fetches. Normally a month: one request either way, and re-checking
// the whole month fills any day a run or a short manual backfill skipped, not only those
// after the latest stored price. A gap longer than that (the backend was off for a while)
// is fetched back to the last stored price, and an instrument with next to no rows (its first five-year backfill, when
// it was added, failed) gets those five years. Fewer than 20 rows rather than none, but not
// "under a year": a fund listed a few months ago has only that much history to give.
export const REFRESH_DAYS = 31;
export const GAP_MARGIN_DAYS = 3;
export const THIN_HISTORY_ROWS = 20;
export const DEEP_BACKFILL_DAYS = 1825;
const MAX_FETCH_DAYS = 4000;

/**
 * Days of history to fetch for one instrument, from its stored `latest` date ('YYYY-MM-DD'
 * or null) and row count, on `today` ('YYYY-MM-DD').
 */
export function refreshDays({ latest, rows }, today) {
  if (!latest || !(rows >= THIN_HISTORY_ROWS)) return DEEP_BACKFILL_DAYS;
  const gap = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latest}T00:00:00Z`)) / DAY_MS);
  return Math.min(Math.max(REFRESH_DAYS, gap + GAP_MARGIN_DAYS), MAX_FETCH_DAYS);
}

/** Stored history per instrument id: { latest: 'YYYY-MM-DD' | null, rows }. */
export async function historyByInstrument() {
  const rows = await query(
    `SELECT i.id, DATE_FORMAT(MAX(p.trade_date), '%Y-%m-%d') AS latest, COUNT(p.trade_date) AS n
       FROM instruments i LEFT JOIN prices p ON p.instrument_id = i.id
      WHERE i.is_active = 1 GROUP BY i.id`
  );
  return new Map(rows.map(r => [r.id, { latest: r.latest, rows: Number(r.n) }]));
}

/**
 * Next minute after `now` that the schedule fires on, within `lookaheadDays`, or null.
 * The mirror of previousScheduledRun.
 */
export function nextScheduledRun(matches, now = new Date(), lookaheadDays = CATCH_UP_LOOKBACK_DAYS) {
  const start = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const steps = lookaheadDays * 24 * 60;
  for (let i = 1; i <= steps; i++) {
    const d = new Date(start + i * MINUTE_MS);
    if (matches(d)) return d;
  }
  return null;
}

/**
 * Most recent minute at or before `now` that the schedule fires on, within the lookback
 * window, or null. `matches(date)` is the cron task's own matcher, so the configured
 * timezone and any CRON_DAILY_REFRESH override are honoured without re-parsing the
 * expression here.
 */
export function previousScheduledRun(matches, now = new Date(), lookbackDays = CATCH_UP_LOOKBACK_DAYS) {
  const start = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const steps = lookbackDays * 24 * 60;
  for (let i = 0; i <= steps; i++) {
    const d = new Date(start - i * MINUTE_MS);
    if (matches(d)) return d;
  }
  return null;
}

/**
 * Did the backend miss the run scheduled at `scheduledAt`? It did unless a run finished
 * after that time, or one started after it recently enough that it may still be in progress.
 */
export function missedRun({ scheduledAt, lastStartedAt, lastFinishedAt, now = new Date() }) {
  if (!scheduledAt) return false;
  if (lastFinishedAt && lastFinishedAt >= scheduledAt) return false;
  if (lastStartedAt && lastStartedAt >= scheduledAt && now - lastStartedAt < STALE_RUN_MS) return false;
  return true;
}

async function recordRun(fields) {
  const cols = Object.keys(fields);
  await query(
    `INSERT INTO job_runs (name, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = VALUES(${c})`).join(', ')}`,
    [JOB_NAME, ...cols.map(c => fields[c])]
  );
}

let running = false;

/**
 * The nightly refresh: prices, sentiment, and predictions for every instrument, then the
 * prediction competition, then a live audit. Each step logs and continues on failure.
 * `reason` is 'scheduled' or 'catch-up'. A second call while one is running is skipped.
 */
export async function runDailyRefresh(reason = 'scheduled') {
  if (running) {
    console.warn(`[cron] Daily refresh (${reason}) skipped — a run is already in progress.`);
    return;
  }
  running = true;
  try {
    await recordRun({ last_started_at: new Date(), last_reason: reason });
    console.log(`[cron] Daily refresh starting (${reason})...`);
    const all = await getAllInstruments();
    const history = await historyByInstrument();
    const today = todayLocal();
    for (const inst of all) {
      try {
        const days = refreshDays(history.get(inst.id) || { latest: null, rows: 0 }, today);
        const p = await fetchAndStorePrices(inst, days);
        const s = await fetchAndStoreSentiment(inst);
        const pred = await predictAndStore(inst);
        const backfill = days > REFRESH_DAYS ? ` backfill=${days}d` : '';
        console.log(`[cron] ${inst.symbol.padEnd(12)} price=${p.latest}${backfill} sentiment=${s.score.toFixed(2)} pred=${pred.predicted_price}`);
      } catch (e) {
        console.error(`[cron] ${inst.symbol} failed:`, e.message);
      }
    }
    console.log('[cron] Daily refresh done.');

    // Prediction competition: make today's forecasts (all models x watchlist x {5,30}),
    // score any predictions that have now matured, and refresh the leaderboard. Runs
    // after prices are updated so forecasts use the latest close.
    try {
      const made = await runDailyPredictions();
      const evald = await runEvaluation();
      console.log(`[cron][competition] predicted=${made.predictions} scored=${evald.scored} models=${evald.models_scored}`);
    } catch (e) {
      console.error('[cron][competition] failed:', e.message);
    }

    // Verify the freshly-updated data — cross-checks stored prices against live Yahoo quotes.
    try {
      const audit = await runAudit({ live: true });
      const { ok, warn, fail } = audit.summary;
      console.log(`[cron][audit] ${ok} ok, ${warn} warn, ${fail} fail (of ${audit.count})`);
      for (const it of audit.items) {
        if (it.status === 'ok') continue;
        const issues = it.checks.filter(c => c.status !== 'ok').map(c => `${c.check}: ${c.detail}`).join('; ');
        console.warn(`[cron][audit] ${it.status.toUpperCase()} ${it.symbol} — ${issues}`);
      }
    } catch (e) {
      console.error('[cron][audit] failed:', e.message);
    }

    await recordRun({ last_finished_at: new Date() });
  } catch (e) {
    console.error('[cron] Daily refresh failed:', e.message);
  } finally {
    running = false;
  }
}

// At startup and every CATCH_UP_CHECK_MS: if the backend was down or the computer asleep
// when the job last should have run, run it now. node-cron only fires on schedule and
// never replays a missed time on its own.
async function catchUpIfMissed(task) {
  try {
    const scheduledAt = previousScheduledRun(d => task.match(d));
    const [row] = await query(`SELECT last_started_at, last_finished_at FROM job_runs WHERE name = ?`, [JOB_NAME]);
    const missed = missedRun({ scheduledAt, lastStartedAt: row?.last_started_at, lastFinishedAt: row?.last_finished_at });
    if (!missed) return;
    console.log(`[cron] Missed the run scheduled for ${scheduledAt.toISOString()} (backend down or computer asleep) — catching up now.`);
    await runDailyRefresh('catch-up');
  } catch (e) {
    console.error('[cron] Catch-up check failed:', e.message);
  }
}

let scheduled = null;

/** When the next scheduled run is due, or null when the job isn't scheduled. */
export function nextDailyRun(now = new Date()) {
  return scheduled ? nextScheduledRun(d => scheduled.match(d), now) : null;
}

export function startDailyJob() {
  console.log(`[cron] Scheduling daily refresh at: ${CRON} (${TIMEZONE})`);
  const task = scheduled = cron.schedule(CRON, () => runDailyRefresh('scheduled'), {
    timezone: TIMEZONE,
    // A run walks every ticker, the competition, and a live audit; if one ever outlasts the
    // interval, skip the next firing rather than running two over the same rows.
    noOverlap: true,
  });
  // Not awaited: the API starts serving while a catch-up run works in the background.
  catchUpIfMissed(task);
  setInterval(() => catchUpIfMissed(task), CATCH_UP_CHECK_MS);
}
