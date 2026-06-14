/**
 * Backfill historical prices + initial sentiment + prediction for every
 * seeded instrument. Run once after `npm run seed`.
 */
import '../src/env.js';
import { pool, getAllInstruments } from '../src/db.js';
import { fetchAndStorePrices } from '../src/services/priceDispatcher.js';
import { fetchAndStoreSentiment } from '../src/services/sentimentService.js';
import { predictAndStore } from '../src/services/prediction.js';

const DAYS = Number(process.env.BACKFILL_DAYS || 365);

async function run() {
  const insts = await getAllInstruments();
  console.log(`Backfilling ${insts.length} instruments × ${DAYS} days...`);
  for (const inst of insts) {
    try {
      const p = await fetchAndStorePrices(inst, DAYS);
      console.log(`  prices  ${inst.symbol.padEnd(12)} fetched=${p.fetched} upserted=${p.inserted_or_updated} latest=${p.latest}`);
      const s = await fetchAndStoreSentiment(inst);
      console.log(`  sentmnt ${inst.symbol.padEnd(12)} headlines=${s.headline_count} score=${s.score.toFixed(3)}`);
      const pred = await predictAndStore(inst);
      console.log(`  predict ${inst.symbol.padEnd(12)} base=${pred.base_price} target=${pred.predicted_price} (${(pred.predicted_return*100).toFixed(2)}%, conf=${pred.confidence})`);
    } catch (e) {
      console.error(`  FAIL    ${inst.symbol}:`, e.message);
    }
  }
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
