/**
 * One-shot walk-forward backfill so the prediction leaderboard is populated from
 * day one. Replays every active model over the last N matured trading days using
 * only point-in-time data, scores against realized prices, and refreshes
 * model_scores. Safe to re-run (idempotent upserts).
 *
 *   npm run backtest            # default 180-day window
 *   npm run backtest -- 120     # custom window (trading days)
 */
import 'dotenv/config';
import { pool } from '../src/db.js';
import { backfill } from '../src/services/competition/harness.js';

const window = Number(process.argv[2]) || 180;

async function run() {
  console.log(`[backtest] walk-forward backfill, window=${window} trading days...`);
  const t0 = Date.now();
  const result = await backfill({ window });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('[backtest] done in', secs + 's:', JSON.stringify(result));
  await pool.end();
}

run().catch(err => { console.error('[backtest] failed:', err); process.exit(1); });
