/**
 * Extend stored price history back to a start date — prices only.
 *
 * `backfill.js` pulls a rolling BACKFILL_DAYS window AND re-runs sentiment + prediction
 * writes for every instrument. This script does neither: it only fetches and upserts
 * daily closes, so it's safe to run whenever the charts need more history than the
 * rolling window kept (e.g. reconstructing 2025 for the value chart's backfilled bars).
 *
 * Existing rows are upserted in place, and a symbol whose data simply doesn't go back
 * that far (a fund listed later) just returns whatever Yahoo has.
 *
 * Usage:
 *   node scripts/backfill-prices.js --from=2025-01-01          # every instrument
 *   node scripts/backfill-prices.js --from=2025-01-01 AMZN QQQ # specific symbols
 *   node scripts/backfill-prices.js --portfolio=1 --from=2025-01-01
 *   npm run backfill:prices -- --from=2025-01-01
 */
import '../src/env.js';
import { pool, query } from '../src/db.js';
import { fetchAndStorePrices } from '../src/services/priceDispatcher.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const symbolArgs = args.filter(a => !a.startsWith('--'));

const from = flag('from') || '2025-01-01';
if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
  console.error(`--from must be YYYY-MM-DD (got ${from})`);
  process.exit(1);
}
// The fetcher takes a lookback in days; overshoot by a week so the boundary day itself
// is included regardless of timezone rounding.
const DAYS = Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 7;
if (DAYS <= 0) {
  console.error(`--from must be in the past (got ${from})`);
  process.exit(1);
}

async function targets() {
  if (symbolArgs.length) {
    const ph = symbolArgs.map(() => '?').join(',');
    return query(`SELECT id, symbol FROM instruments WHERE symbol IN (${ph}) ORDER BY symbol`, symbolArgs);
  }
  const pid = flag('portfolio');
  if (pid) {
    // Everything the portfolio ever traded, not just what it holds now — the value
    // chart reconstructs closed positions too.
    return query(
      `SELECT DISTINCT i.id, i.symbol
         FROM instruments i
         JOIN transactions t ON t.symbol = i.symbol
        WHERE t.portfolio_id = ? AND t.side IN ('buy','sell')
        ORDER BY i.symbol`,
      [pid]
    );
  }
  return query(`SELECT id, symbol FROM instruments ORDER BY symbol`);
}

async function coverage(instrumentId) {
  const [row] = await query(
    `SELECT COUNT(*) pts,
            DATE_FORMAT(MIN(trade_date),'%Y-%m-%d') first_dt,
            DATE_FORMAT(MAX(trade_date),'%Y-%m-%d') last_dt
       FROM prices WHERE instrument_id = ?`,
    [instrumentId]
  );
  return row || { pts: 0, first_dt: null, last_dt: null };
}

async function run() {
  const insts = await targets();
  if (insts.length === 0) {
    console.error('No matching instruments.');
    await pool.end();
    return;
  }
  console.log(`Backfilling prices for ${insts.length} instrument(s) from ${from} (${DAYS} days)…\n`);

  let ok = 0, failed = 0, stillShort = 0;
  for (const inst of insts) {
    const before = await coverage(inst.id);
    try {
      const p = await fetchAndStorePrices(inst, DAYS);
      const after = await coverage(inst.id);
      const short = after.first_dt && after.first_dt > from;
      if (short) stillShort++;
      ok++;
      console.log(
        `  ${short ? 'SHORT  ' : 'ok     '} ${inst.symbol.padEnd(14)} fetched=${String(p.fetched).padEnd(5)} upserted=${String(p.inserted_or_updated).padEnd(5)} ` +
        `${before.pts} pts (${before.first_dt}) -> ${after.pts} pts (${after.first_dt})`
      );
    } catch (e) {
      failed++;
      console.error(`  FAIL    ${inst.symbol.padEnd(14)} ${e.message}`);
    }
  }

  console.log(`\nDone: ${ok} ok, ${failed} failed, ${stillShort} still start after ${from} (no earlier data published).`);
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
