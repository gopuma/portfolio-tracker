/**
 * Backfill the full available history for the FX instruments (KRW=X, JPYKRW=X).
 *
 * The regular `backfill.js` pulls a rolling BACKFILL_DAYS window (365 by default),
 * which leaves FX history far shorter than the transaction history it has to convert.
 * Yahoo publishes these pairs from 2003-12-01, so this pulls the whole run in one call
 * and upserts it — safe to re-run, existing rows are updated in place.
 *
 * Usage:
 *   npm run backfill:fx                # KRW=X + JPYKRW=X, full history
 *   node scripts/backfill-fx.js KRW=X  # a specific pair
 *   FX_BACKFILL_DAYS=3650 npm run backfill:fx
 */
import '../src/env.js';
import { pool, query } from '../src/db.js';
import { fetchAndStorePrices } from '../src/services/priceDispatcher.js';

const DEFAULT_SYMBOLS = ['KRW=X', 'JPYKRW=X'];

// Yahoo's earliest daily bar for these pairs is 2003-12-01; overshoot so it clamps
// to whatever is actually published rather than us guessing the boundary.
const DAYS = Number(process.env.FX_BACKFILL_DAYS || 9000);

async function coverage(symbol) {
  const [row] = await query(
    `SELECT COUNT(p.id) pts,
            DATE_FORMAT(MIN(p.trade_date),'%Y-%m-%d') first_dt,
            DATE_FORMAT(MAX(p.trade_date),'%Y-%m-%d') last_dt
       FROM instruments i LEFT JOIN prices p ON p.instrument_id = i.id
      WHERE i.symbol = ?`,
    [symbol]
  );
  return row || { pts: 0, first_dt: null, last_dt: null };
}

async function run() {
  const symbols = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SYMBOLS;

  for (const symbol of symbols) {
    const [inst] = await query('SELECT id, symbol FROM instruments WHERE symbol = ?', [symbol]);
    if (!inst) {
      console.error(`  SKIP    ${symbol}: not in instruments table`);
      continue;
    }

    const before = await coverage(symbol);
    try {
      const p = await fetchAndStorePrices(inst, DAYS);
      const after = await coverage(symbol);
      console.log(
        `  fx      ${symbol.padEnd(10)} fetched=${p.fetched} upserted=${p.inserted_or_updated}\n` +
        `          before: ${before.pts} pts (${before.first_dt} .. ${before.last_dt})\n` +
        `          after:  ${after.pts} pts (${after.first_dt} .. ${after.last_dt})`
      );
    } catch (e) {
      console.error(`  FAIL    ${symbol}:`, e.message);
    }
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
