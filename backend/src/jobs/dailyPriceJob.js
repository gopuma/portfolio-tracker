import cron from 'node-cron';
import { getAllInstruments } from '../db.js';
import { fetchAndStorePrices } from '../services/priceDispatcher.js';
import { fetchAndStoreSentiment } from '../services/sentimentService.js';
import { predictAndStore } from '../services/prediction.js';
import { runAudit } from '../services/auditService.js';
import { runDailyPredictions, runEvaluation } from '../services/competition/harness.js';

const CRON = process.env.CRON_DAILY_REFRESH || '0 23 * * 1-5';

export function startDailyJob() {
  console.log(`[cron] Scheduling daily refresh at: ${CRON}`);
  cron.schedule(CRON, async () => {
    console.log('[cron] Daily refresh starting...');
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
  }, { timezone: 'Asia/Seoul' });
}
