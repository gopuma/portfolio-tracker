/**
 * Load the long daily history the stress test's historical replay runs on, into
 * `scenario_history` (migration 009). Nothing in `prices` is touched.
 *
 *   - Yahoo, adjusted close back to 1985: every non-cash holding in any portfolio, every
 *     proxy in services/historicalReplay.js, and the USD/KRW and JPY/KRW rates
 *   - FRED: DEXKOUS (KRW per USD, from 1981) and DEXJPUS (JPY per USD) to carry the
 *     exchange rates back before Yahoo's start in Dec 2003; DTB3 (3-month T-bill rate)
 *   - TBILL: a total-return index built from DTB3, for T-bill funds
 *   - KRX-GOLD-SPOT isn't on Yahoo, so its rows are copied from `prices`
 *
 * Safe to re-run: rows are upserted. Run it again now and then to extend the AI-boom
 * replay, which runs to the latest stored date, and after adding a holding.
 *
 * Usage:
 *   node scripts/load-scenario-history.js            # everything
 *   node scripts/load-scenario-history.js NVDA ^SOX  # just these series
 *   npm run history:load
 */
import '../src/env.js';
import { pool, query } from '../src/db.js';
import { fetchDailyBars } from '../src/services/priceFetcher.js';
import { HISTORY_FROM, referenceSeries, tbillIndex } from '../src/services/historicalReplay.js';

const FRED = ['DEXKOUS', 'DEXJPUS', 'DTB3'];
const NOT_ON_YAHOO = new Set(['KRX-GOLD-SPOT', 'TBILL']);
const DAYS = Math.ceil((Date.now() - Date.parse(`${HISTORY_FROM}T00:00:00Z`)) / 86400000) + 7;

async function upsert(series, rows) {
  let written = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    await query(
      `INSERT INTO scenario_history (series, trade_date, value) VALUES ${chunk.map(() => '(?, ?, ?)').join(',')}
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      chunk.flatMap(x => [series, x.date, x.value])
    );
    written += chunk.length;
  }
  return written;
}

async function loadYahoo(symbol) {
  const { bars } = await fetchDailyBars(symbol, DAYS);
  const rows = bars
    .map(b => ({ date: b.trade_date, value: Number(b.adj_close ?? b.close_px) }))
    .filter(r => r.date >= HISTORY_FROM && Number.isFinite(r.value) && r.value > 0);
  return upsert(symbol, rows);
}

async function fetchFred(id) {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`FRED ${id}: HTTP ${res.status}`);
  const rows = [];
  for (const line of (await res.text()).split('\n').slice(1)) {
    const [date, v = ''] = line.trim().split(',');
    // FRED leaves market holidays blank (older files used '.'); Number('') would read as 0.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || v.trim() === '' || v === '.') continue;
    const value = Number(v);
    if (Number.isFinite(value)) rows.push({ date, value });
  }
  return rows;
}

async function copyFromPrices(symbol) {
  const rows = await query(
    `SELECT DATE_FORMAT(p.trade_date, '%Y-%m-%d') AS date, p.close_px AS value
       FROM prices p JOIN instruments i ON i.id = p.instrument_id
      WHERE i.symbol = ? ORDER BY p.trade_date`,
    [symbol]
  );
  return upsert(symbol, rows.map(r => ({ date: r.date, value: Number(r.value) })));
}

async function run() {
  const wanted = process.argv.slice(2);
  const held = (await query(
    `SELECT DISTINCT symbol FROM portfolio_holdings WHERE symbol NOT LIKE 'CASH:%' ORDER BY symbol`
  )).map(r => r.symbol);
  const yahoo = [...new Set([...held, ...referenceSeries()])]
    .filter(s => !s.startsWith('FRED:') && !NOT_ON_YAHOO.has(s))
    .filter(s => !wanted.length || wanted.includes(s));

  const report = [];
  for (const s of yahoo) {
    try { report.push({ series: s, rows: await loadYahoo(s) }); }
    catch (e) { report.push({ series: s, rows: 0, error: String(e.message).slice(0, 60) }); }
  }

  if (!wanted.length || wanted.some(w => w.startsWith('FRED:') || w === 'TBILL')) {
    for (const id of FRED) {
      try {
        const rows = await fetchFred(id);
        report.push({ series: `FRED:${id}`, rows: await upsert(`FRED:${id}`, rows.filter(r => r.date >= '1980-01-01')) });
        if (id === 'DTB3') report.push({ series: 'TBILL', rows: await upsert('TBILL', tbillIndex(rows)) });
      } catch (e) { report.push({ series: `FRED:${id}`, rows: 0, error: String(e.message).slice(0, 60) }); }
    }
  }

  if (held.includes('KRX-GOLD-SPOT') && (!wanted.length || wanted.includes('KRX-GOLD-SPOT'))) {
    report.push({ series: 'KRX-GOLD-SPOT', rows: await copyFromPrices('KRX-GOLD-SPOT') });
  }

  const cov = await query(
    `SELECT series, DATE_FORMAT(MIN(trade_date), '%Y-%m-%d') AS first, DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS last, COUNT(*) AS n
       FROM scenario_history GROUP BY series ORDER BY first, series`
  );
  const bySeries = new Map(report.map(r => [r.series, r]));
  console.table(cov.map(c => ({ ...c, error: bySeries.get(c.series)?.error || '' })));
  const failed = report.filter(r => r.error);
  if (failed.length) console.table(failed);
}

run()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
