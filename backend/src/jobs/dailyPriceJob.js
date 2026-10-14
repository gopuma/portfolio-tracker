import cron from 'node-cron';
import { getAllInstruments, query } from '../db.js';
import { fetchAndStorePrices } from '../services/priceDispatcher.js';
import { fetchAndStoreSentiment } from '../services/sentimentService.js';
import { predictAndStore } from '../services/prediction.js';
import { runAudit } from '../services/auditService.js';
import { runDailyPredictions, runEvaluation } from '../services/competition/harness.js';

// 06:30 KST, Tue–Sat: after the US close in both DST regimes (16:00 ET is 05:00 KST on
// EDT, 06:00 KST on EST), so the run stores settled closes rather than a partial bar for
// a session still in progress. Tue–Sat because a Friday US session closes Sat 05:00 KST.
const CRON = process.env.CRON_DAILY_REFRESH || '30 6 * * 2-6';
const TIMEZONE = 'Asia/Seoul';
const JOB_NAME = 'daily-refresh';

// How far back startup looks for a scheduled run it may have missed. The job fetches a
// 7-day window, so one catch-up run covers any gap within it.
const CATCH_UP_LOOKBACK_DAYS = 7;
// A run that started but never finished (the backend was stopped or restarted mid-run)
// counts as missed once it is this old; younger than that it may still be going.
const STALE_RUN_MS = 30 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

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
    for (const inst of all) {
      try {
        const p = await fetchAndStorePrices(inst, 7);
        const s = await fetchAndStoreSentiment(inst);
        const pred = await predictAndStore(inst);
        console.log(`[cron] ${inst.symbol.padEnd(12)} price=${p.latest} sentiment=${s.score.toFixed(2)} pred=${pred.predicted_price}`);
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

// On startup: if the backend was down when the job last should have run, run it now.
// node-cron only fires on schedule and never replays a missed time on its own.
async function catchUpIfMissed(task) {
  try {
    const scheduledAt = previousScheduledRun(d => task.match(d));
    const [row] = await query(`SELECT last_started_at, last_finished_at FROM job_runs WHERE name = ?`, [JOB_NAME]);
    const missed = missedRun({ scheduledAt, lastStartedAt: row?.last_started_at, lastFinishedAt: row?.last_finished_at });
    if (!missed) return;
    console.log(`[cron] Missed the run scheduled for ${scheduledAt.toISOString()} (backend was down) — catching up now.`);
    await runDailyRefresh('catch-up');
  } catch (e) {
    console.error('[cron] Catch-up check failed:', e.message);
  }
}

export function startDailyJob() {
  console.log(`[cron] Scheduling daily refresh at: ${CRON} (${TIMEZONE})`);
  const task = cron.schedule(CRON, () => runDailyRefresh('scheduled'), {
    timezone: TIMEZONE,
    // A run walks every ticker, the competition, and a live audit; if one ever outlasts the
    // interval, skip the next firing rather than running two over the same rows.
    noOverlap: true,
  });
  // Not awaited: the API starts serving while a catch-up run works in the background.
  catchUpIfMissed(task);
}
