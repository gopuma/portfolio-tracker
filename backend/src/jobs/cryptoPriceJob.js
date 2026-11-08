import cron from 'node-cron';
import { query } from '../db.js';
import { fetchAndStorePrices } from '../services/priceDispatcher.js';

// Bitcoin trades around the clock, weekends included, so its stored price can't wait for
// the Tue–Sat stock refresh. Five past every hour, re-fetch the last few days of each
// crypto instrument. Today's bar is still open; each run overwrites it with the latest
// trade, so portfolio values, the stress test and the projection stay within an hour.
const CRON = process.env.CRON_CRYPTO_REFRESH || '5 * * * *';
const TIMEZONE = 'Asia/Seoul';
const DAYS = 3;
const JOB_NAME = 'crypto-refresh';
// A missed hourly firing (the computer was asleep) is caught up by this check, which runs
// once the last run is more than an hour and a bit old.
const CATCH_UP_CHECK_MS = 10 * 60 * 1000;
const CATCH_UP_AFTER_MS = 65 * 60 * 1000;

let running = false;
let lastRunAt = 0;

export async function runCryptoRefresh(reason = 'scheduled') {
  if (running) return;
  running = true;
  lastRunAt = Date.now();
  try {
    await query(
      `INSERT INTO job_runs (name, last_started_at, last_reason) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE last_started_at = VALUES(last_started_at), last_reason = VALUES(last_reason)`,
      [JOB_NAME, new Date(), reason]
    );
    const rows = await query(`SELECT * FROM instruments WHERE is_active = 1 AND market = 'CRYPTO' ORDER BY symbol`);
    for (const inst of rows) {
      try {
        const p = await fetchAndStorePrices(inst, DAYS);
        console.log(`[cron][crypto] ${inst.symbol.padEnd(14)} price=${p.latest} (${reason})`);
      } catch (e) {
        console.error(`[cron][crypto] ${inst.symbol} failed:`, e.message);
      }
    }
    await query(`UPDATE job_runs SET last_finished_at = ? WHERE name = ?`, [new Date(), JOB_NAME]);
  } catch (e) {
    console.error('[cron][crypto] refresh failed:', e.message);
  } finally {
    running = false;
  }
}

export function startCryptoJob() {
  console.log(`[cron] Scheduling crypto refresh at: ${CRON} (${TIMEZONE})`);
  cron.schedule(CRON, () => runCryptoRefresh('scheduled'), { timezone: TIMEZONE, noOverlap: true });
  // Not awaited: catch up on whatever moved while the backend was down.
  runCryptoRefresh('startup');
  setInterval(() => {
    if (Date.now() - lastRunAt > CATCH_UP_AFTER_MS) runCryptoRefresh('catch-up');
  }, CATCH_UP_CHECK_MS);
}
