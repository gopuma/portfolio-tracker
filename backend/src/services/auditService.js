/**
 * Independently audits each instrument's stored values against recomputation and
 * (optionally) a live Yahoo quote. Shared by the /api/audit route and the daily job.
 */
import { query } from '../db.js';
import { riskStats } from './stats.js';
import { fetchQuotes } from './priceFetcher.js';

const TRADING_DAYS = 252;
const KRX_SYMBOL = 'KRX-GOLD-SPOT'; // priced via Naver, not on Yahoo — skip live check

const worst = (statuses) => statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'ok';

// Independent volatility reimplementation (separate from stats.js) so the audit
// genuinely cross-checks the production calc rather than reusing it.
function independentVol(closes) {
  if (closes.length < 21) return null;
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(closes[i] / closes[i - 1] - 1);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(TRADING_DAYS);
}

function priorClose(series, daysAgo) {
  const cut = new Date();
  cut.setDate(cut.getDate() - daysAgo);
  const cutStr = cut.toISOString().slice(0, 10);
  let found = null;
  for (const p of series) { if (p.date <= cutStr) found = p.close; else break; }
  return found;
}

export async function runAudit({ live = false } = {}) {
  const instruments = await query(
    `SELECT id, symbol, market, currency FROM instruments WHERE is_active = 1 ORDER BY market, symbol`
  );
  const rows = await query(
    `SELECT i.symbol, p.trade_date, p.close_px
       FROM instruments i JOIN prices p ON p.instrument_id = i.id
      WHERE i.is_active = 1 AND p.trade_date >= DATE_SUB(CURDATE(), INTERVAL 400 DAY)
      ORDER BY i.symbol ASC, p.trade_date ASC`
  );
  const seriesBy = new Map();
  for (const r of rows) {
    const arr = seriesBy.get(r.symbol) || [];
    arr.push({ date: (r.trade_date instanceof Date ? r.trade_date.toISOString() : String(r.trade_date)).slice(0, 10), close: Number(r.close_px) });
    seriesBy.set(r.symbol, arr);
  }

  let quotes = {};
  if (live) quotes = await fetchQuotes(instruments.map(i => i.symbol).filter(s => s !== KRX_SYMBOL));

  const today = new Date().toISOString().slice(0, 10);
  const items = instruments.map(inst => {
    const series = seriesBy.get(inst.symbol) || [];
    const checks = [];
    const add = (check, status, detail, value) => checks.push({ check, status, detail, value });

    if (series.length === 0) {
      add('price', 'fail', 'No price data in DB', null);
      return { symbol: inst.symbol, market: inst.market, currency: inst.currency, status: 'fail', checks };
    }

    const closes = series.map(s => s.close);
    const last = series[series.length - 1];
    const staleDays = Math.round((new Date(today) - new Date(last.date)) / 86400000);

    const nonPositive = closes.filter(c => !(c > 0)).length;
    const freshStatus = staleDays <= 4 ? 'ok' : staleDays <= 10 ? 'warn' : 'fail';
    add('price', nonPositive > 0 ? 'fail' : freshStatus,
      nonPositive > 0 ? `${nonPositive} non-positive close(s)` : `${last.close} as of ${last.date} (${staleDays}d ago)`,
      last.close);

    const cut1y = new Date(); cut1y.setDate(cut1y.getDate() - 365);
    const cutStr = cut1y.toISOString().slice(0, 10);
    const oneYearSeries = series.filter(s => s.date >= cutStr);
    add('coverage', oneYearSeries.length >= 200 ? 'ok' : oneYearSeries.length >= 100 ? 'warn' : 'fail', `${oneYearSeries.length} obs in last 1y`, oneYearSeries.length);

    let maxMove = 0;
    for (let i = 1; i < closes.length; i++) { const m = Math.abs(closes[i] / closes[i - 1] - 1); if (m > maxMove) maxMove = m; }
    add('integrity', maxMove > 0.4 ? 'warn' : 'ok', `max 1-day move ${(maxMove * 100).toFixed(1)}%`, maxMove);

    const prod = riskStats(oneYearSeries, 0);
    const indep = independentVol(oneYearSeries.map(s => s.close));
    if (prod?.vol == null || indep == null) {
      add('volatility', 'warn', 'insufficient data to verify', null);
    } else {
      const relDiff = Math.abs(prod.vol - indep) / (Math.abs(indep) || 1);
      add('volatility', relDiff < 0.01 ? 'ok' : 'fail',
        `app ${(prod.vol * 100).toFixed(1)}% vs indep ${(indep * 100).toFixed(1)}% (Δ ${(relDiff * 100).toFixed(2)}%)`, prod.vol);
    }

    const c30 = priorClose(series, 30), c365 = priorClose(series, 365);
    const ret30 = c30 ? last.close / c30 - 1 : null;
    const ret1y = c365 ? last.close / c365 - 1 : null;
    add('returns', (ret30 == null && ret1y == null) ? 'warn' : 'ok',
      `30d ${ret30 == null ? '–' : (ret30 * 100).toFixed(1) + '%'} · 1y ${ret1y == null ? '–' : (ret1y * 100).toFixed(1) + '%'}`, ret30);

    if (live) {
      if (inst.symbol === KRX_SYMBOL) {
        add('live price', 'ok', 'n/a (Naver-sourced)', null);
      } else {
        const q = quotes[inst.symbol];
        if (!q || q.price == null) {
          add('live price', 'warn', 'no live quote returned', null);
        } else {
          const diff = Math.abs(last.close - q.price) / (q.price || 1);
          add('live price', diff < 0.02 ? 'ok' : diff < 0.1 ? 'warn' : 'fail',
            `DB ${last.close} vs live ${q.price} (Δ ${(diff * 100).toFixed(1)}%)`, q.price);
        }
      }
    }

    return { symbol: inst.symbol, market: inst.market, currency: inst.currency, status: worst(checks.map(c => c.status)), checks };
  });

  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const it of items) summary[it.status]++;

  return { generated_at: new Date().toISOString(), live, count: items.length, summary, items };
}
