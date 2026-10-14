/**
 * Backfill the full available history for the FX instruments (KRW=X, JPYKRW=X).
 *
 * The regular `backfill.js` pulls a rolling BACKFILL_DAYS window (365 by default),
 * which leaves FX history far shorter than the transaction history it has to convert.
 * Yahoo publishes these pairs from 2003-12-01, so this pulls the whole run in one call
 * and upserts it — safe to re-run, existing rows are updated in place.
 *
 * `--replace` instead rebuilds a pair's history from scratch: the full series is fetched
 * first, then the stored rows are deleted and the fresh ones inserted in ONE transaction,
 * so a failure leaves the old history untouched. Upserting can't do this job when stored
 * dates are wrong — the misdated rows would stay behind. (Before the exchange-timezone
 * fix in priceFetcher, every British Summer Time bar was filed a day early.)
 *
 * Usage:
 *   npm run backfill:fx                          # KRW=X + JPYKRW=X, full history
 *   node scripts/backfill-fx.js KRW=X            # a specific pair
 *   node scripts/backfill-fx.js --replace        # rebuild both pairs' history
 *   FX_BACKFILL_DAYS=3650 npm run backfill:fx
 */
import '../src/env.js';
import { pool, query, withTransaction } from '../src/db.js';
import { fetchAndStorePrices } from '../src/services/priceDispatcher.js';
import { fetchDailyBars, storeBars } from '../src/services/priceFetcher.js';

const DEFAULT_SYMBOLS = ['KRW=X', 'JPYKRW=X'];

// Yahoo's earliest daily bar for these pairs is 2003-12-01; overshoot so it clamps
// to whatever is actually published rather than us guessing the boundary.
const DAYS = Number(process.env.FX_BACKFILL_DAYS || 9000);

// --replace refuses to swap in a fetch that returned much less than what is stored — a
// truncated or throttled Yahoo response must not wipe decades of history.
const MIN_REPLACE_RATIO = 0.9;

async function coverage(symbol) {
  const [row] = await query(
    `SELECT COUNT(p.id) pts,
            DATE_FORMAT(MIN(p.trade_date),'%Y-%m-%d') first_dt,
            DATE_FORMAT(MAX(p.trade_date),'%Y-%m-%d') last_dt
            , COALESCE(SUM(DAYOFWEEK(p.trade_date) IN (1, 7)), 0) weekend
       FROM instruments i LEFT JOIN prices p ON p.instrument_id = i.id
      WHERE i.symbol = ?`,
    [symbol]
  );
  return row || { pts: 0, first_dt: null, last_dt: null, weekend: 0 };
}

const describe = c => `${c.pts} pts (${c.first_dt} .. ${c.last_dt}), ${c.weekend} on weekends`;

async function replaceHistory(inst, before) {
  const { bars, timeZone } = await fetchDailyBars(inst.symbol, DAYS);
  if (bars.length < before.pts * MIN_REPLACE_RATIO) {
    throw new Error(`fetched only ${bars.length} bars vs ${before.pts} stored — not replacing`);
  }
  const written = await withTransaction(async q => {
    await q('DELETE FROM prices WHERE instrument_id = ?', [inst.id]);
    return storeBars(q, inst.id, bars);
  });
  return { fetched: bars.length, written, timeZone };
}

async function run() {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const symbolArgs = args.filter(a => !a.startsWith('--'));
  const symbols = symbolArgs.length ? symbolArgs : DEFAULT_SYMBOLS;

  for (const symbol of symbols) {
    const [inst] = await query('SELECT id, symbol FROM instruments WHERE symbol = ?', [symbol]);
    if (!inst) {
      console.error(`  SKIP    ${symbol}: not in instruments table`);
      continue;
    }

    const before = await coverage(symbol);
    try {
      if (replace) {
        const r = await replaceHistory(inst, before);
        const after = await coverage(symbol);
        console.log(
          `  replace ${symbol.padEnd(10)} fetched=${r.fetched} written=${r.written} (dated in ${r.timeZone})\n` +
          `          before: ${describe(before)}\n` +
          `          after:  ${describe(after)}`
        );
        continue;
      }
      const p = await fetchAndStorePrices(inst, DAYS);
      const after = await coverage(symbol);
      console.log(
        `  fx      ${symbol.padEnd(10)} fetched=${p.fetched} upserted=${p.inserted_or_updated}\n` +
        `          before: ${describe(before)}\n` +
        `          after:  ${describe(after)}`
      );
    } catch (e) {
      console.error(`  FAIL    ${symbol}:`, e.message);
    }
  }

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
