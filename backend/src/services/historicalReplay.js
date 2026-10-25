/**
 * Historical replay for the stress test: run today's holdings through a past market event
 * using what actually happened, day by day.
 *
 * Two bases, chosen per request:
 *   'factor' (default) — every holding follows a PROXY (an index or fund with a long
 *      history, chosen per holding below), scaled by the holding's beta to that proxy as
 *      measured today: path = proxy_path ^ β. This is the factor-model approach (historical
 *      factor moves × today's sensitivities) that Morningstar and Barra use. It keeps a
 *      company's own early history out of it: Amazon rose about eightfold in the year after
 *      its 1997 listing, which says nothing about how today's Amazon would behave.
 *   'actual' — a holding that was trading for the whole event uses its OWN prices, an
 *      exact replay; the rest fall back to proxies as above. Best for recent events.
 * In both, a holding with no proxy reaching back that far (gold before Aug 2000, Korean
 * shares before Nov 1996) gets the FALLBACK: the S&P 500's path scaled by its beta to it.
 * Every path is then restated in the display currency at each day's actual exchange rate,
 * so a won holding seen in dollars carries the won's moves through the event too. Cash
 * moves only with its exchange rate.
 *
 * Prices come from `scenario_history` (see migration 009 and the loader script).
 */
import { query } from '../db.js';
import { regress, toReturns } from './stats.js';

export const HISTORY_FROM = '1985-01-01';

// Peak to trough for a crash, trough to peak for a boom, on the index named in `note`.
// `end: null` runs to the latest stored date. `group: 'crypto'` lists an event on its own
// row in the picker.
export const REPLAY_EVENTS = [
  { key: 'crash-1987', kind: 'crash', label: '1987 crash', start: '1987-08-25', end: '1987-12-04', note: 'S&P 500 peak to trough, through Black Monday (19 Oct 1987)' },
  { key: 'asia-1997', kind: 'crash', label: 'Asian crisis 1997–98', start: '1997-06-17', end: '1998-06-16', note: 'KOSPI peak to trough; the won lost about half its value against the dollar' },
  { key: 'dotcom-crash', kind: 'crash', label: 'Dot-com crash 2000–02', start: '2000-03-10', end: '2002-10-09', note: 'NASDAQ peak to trough' },
  { key: 'gfc', kind: 'crash', label: 'Financial crisis 2007–09', start: '2007-10-09', end: '2009-03-09', note: 'S&P 500 peak to trough' },
  { key: 'covid', kind: 'crash', label: 'COVID crash 2020', start: '2020-02-19', end: '2020-03-23', note: 'S&P 500 peak to trough' },
  { key: 'rates-2022', kind: 'crash', label: 'Rate shock 2022', start: '2021-11-19', end: '2022-12-28', note: 'NASDAQ peak to trough' },
  // Crashes that started in crypto itself, which a stock index understates.
  { key: 'crypto-2018', group: 'crypto', kind: 'crash', label: 'Crypto winter 2018', start: '2017-12-16', end: '2018-12-15', note: 'Bitcoin peak to trough, after the 2017 bubble' },
  { key: 'crypto-2022', group: 'crypto', kind: 'crash', label: 'Crypto crash 2022', start: '2021-11-08', end: '2022-11-21', note: 'Bitcoin peak to trough, through the Terra/Luna and FTX collapses' },
  { key: 'crypto-2025', group: 'crypto', kind: 'crash', label: 'Bitcoin slide 2025–26', start: '2025-10-06', end: '2026-06-30', note: 'Bitcoin peak to trough, from its all-time high' },
  { key: 'dotcom-bubble', kind: 'boom', label: 'Dot-com bubble 1998–2000', start: '1998-10-08', end: '2000-03-10', note: 'NASDAQ trough to peak' },
  { key: 'covid-rally', kind: 'boom', label: 'Post-COVID rally 2020–22', start: '2020-03-23', end: '2022-01-03', note: 'S&P 500 trough to peak' },
  { key: 'crypto-2020', group: 'crypto', kind: 'boom', label: 'Bitcoin rally 2020–21', start: '2020-03-12', end: '2021-11-08', note: 'Bitcoin trough to peak, from the COVID low' },
  { key: 'crypto-2023', group: 'crypto', kind: 'boom', label: 'Bitcoin rally 2023–25', start: '2022-11-21', end: '2025-10-06', note: 'Bitcoin trough to peak, from the FTX low to its all-time high' },
  { key: 'ai-boom', kind: 'boom', label: 'AI boom 2023–', start: '2022-12-28', end: null, note: 'NASDAQ from the post-ChatGPT low to the latest close' },
];

// Proxies to fall back on, in order, for when a holding wasn't trading yet. The first one
// whose history covers the whole event is used.
const SEMIS = ['^SOX', '^NDX'];           // PHLX Semiconductor from 1994, NASDAQ-100 before
const US_DIVIDEND = ['IWD', '^GSPC'];     // Russell 1000 Value ETF from 2000, S&P 500 before
export const PROXY_CHAINS = {
  AMZN: ['^IXIC'],
  NVDA: SEMIS, TSM: SEMIS, ASML: SEMIS, AVGO: SEMIS,
  GOOG: ['^NDX'], META: ['^NDX'], TSLA: ['^NDX'], QQQ: ['^NDX'], QQQM: ['^NDX'],
  RKLB: ['^RUT'], SPCX: ['^RUT'],                   // small, volatile growth: Russell 2000
  WPM: ['^XAU'], FNV: ['^XAU'],                     // PHLX Gold/Silver miners
  AGNC: ['XLF', '^GSPC'],                           // financials sector ETF from 1998
  SCHD: US_DIVIDEND,
  SGOV: ['TBILL'],
  JAAA: ['LQD', 'TBILL'],                           // corporate bonds from 2002; AAA CLOs did fall in 2008
  '005930.KS': ['^KS11'], '000660.KS': ['^KS11'], '069500.KS': ['^KS11'], '0074K0.KS': ['^KS11'],
  '426030.KS': ['^NDX'],                            // NASDAQ-100 fund listed in Seoul
  '458730.KS': US_DIVIDEND, '489250.KS': US_DIVIDEND, // US dividend funds listed in Seoul
  '0046A0.KS': ['TBILL'],                           // US T-bill fund listed in Seoul
  'KRX-GOLD-SPOT': ['GC=F'],                        // gold futures from Aug 2000
  'BTC-USD': ['BTC-USD'],                           // global bitcoin from Sep 2014
  'UPBIT-KRW-BTC': ['BTC-USD'],                     // Upbit's won price from Sep 2017
};
// Any other coin follows bitcoin by its beta to it.
const DEFAULT_CHAINS = { US: ['^GSPC'], KR: ['^KS11'], CRYPTO: ['BTC-USD'] };
export const FALLBACK_INDEX = '^GSPC';

export const SERIES_NAMES = {
  '^GSPC': 'S&P 500', '^IXIC': 'NASDAQ Composite', '^NDX': 'NASDAQ-100', '^RUT': 'Russell 2000',
  '^SOX': 'PHLX Semiconductor', '^XAU': 'PHLX Gold/Silver miners', '^KS11': 'KOSPI',
  XLF: 'Financials sector ETF', IWD: 'Russell 1000 Value ETF', LQD: 'Corporate bond ETF',
  'GC=F': 'Gold futures', TBILL: '3-month T-bills', 'BTC-USD': 'Bitcoin',
};

// What the summary line reports each market did over the event. Bitcoin shows only for
// events after its prices begin (Sep 2014).
const SUMMARY_INDEXES = ['^GSPC', '^IXIC', '^KS11', 'BTC-USD'];

// The FX series the replay converts with: Yahoo's from Dec 2003, FRED's daily noon rates before.
export const FX_SERIES = ['KRW=X', 'JPYKRW=X', 'FRED:DEXKOUS', 'FRED:DEXJPUS'];
// Every series the replay can draw on besides holdings' own: proxies, FX, the fallback,
// and the indexes the summary line reports.
export function referenceSeries() {
  const s = new Set([FALLBACK_INDEX, ...SUMMARY_INDEXES, '^NDX', ...FX_SERIES]);
  for (const chain of [...Object.values(PROXY_CHAINS), ...Object.values(DEFAULT_CHAINS)]) for (const x of chain) s.add(x);
  return [...s];
}

// Native currency of a proxy or index series. (A holding's own series is in the holding's
// currency and never goes through this.)
export function seriesCurrency(series) {
  return series === '^KS11' || series.endsWith('.KS') || series === 'KRX-GOLD-SPOT' || series === 'UPBIT-KRW-BTC' ? 'KRW' : 'USD';
}

export const BASES = ['factor', 'actual'];

/**
 * The ordered list of series a holding can be replayed from: its proxies, preceded by its
 * own prices on the 'actual' basis.
 */
export function chainFor(symbol, market, basis = 'factor') {
  const proxies = PROXY_CHAINS[symbol] || DEFAULT_CHAINS[market] || [FALLBACK_INDEX];
  return basis === 'actual' ? [symbol, ...proxies] : proxies;
}

// Longest run of calendar days a series may skip inside an event and still count as
// covering it. Long holidays (Korea's Chuseok, Lunar New Year) run to about ten days.
const MAX_GAP_DAYS = 15;

/**
 * True when `rows` (ascending { date, value }, loaded from a little before `start`)
 * actually trades through [start, end]: a price on or within a few days of the first day,
 * one within a week of the last, and no hole longer than MAX_GAP_DAYS in between. Yahoo's
 * histories do have holes — KODEX 200 is missing Feb 2007 to Apr 2009 — so the first and
 * last dates alone aren't enough.
 */
export function coversWindow(rows, start, end) {
  if (!rows || rows.length === 0) return false;
  const inside = rows.filter(r => r.date <= end);
  if (!inside.length || inside[0].date > shiftDate(start, 4) || inside[inside.length - 1].date < shiftDate(end, -7)) return false;
  for (let i = 1; i < inside.length; i++) {
    if (inside[i].date < start) continue;
    if ((Date.parse(inside[i].date) - Date.parse(inside[i - 1].date)) / 86400000 > MAX_GAP_DAYS) return false;
  }
  return true;
}

/** First series in `chain` whose rows (from `rowsBySeries`) cover the event, or null. */
export function pickSource(chain, rowsBySeries, start, end) {
  for (const s of chain) if (coversWindow(rowsBySeries.get(s), start, end)) return s;
  return null;
}

// Total-return index of rolling 3-month T-bills: each day accrues the prior day's
// annualized rate (DTB3, a discount-basis percentage) over the calendar days elapsed.
export function tbillIndex(dtb3) {
  const out = [];
  let level = 1;
  for (let i = 0; i < dtb3.length; i++) {
    if (i > 0) {
      const days = (Date.parse(dtb3[i].date) - Date.parse(dtb3[i - 1].date)) / 86400000;
      level *= 1 + (dtb3[i - 1].value / 100) * (days / 360);
    }
    out.push({ date: dtb3[i].date, value: level });
  }
  return out.filter(r => r.date >= HISTORY_FROM);
}

/** Largest peak-to-trough fall along a value path: { dd, peakIdx, troughIdx }. dd ≤ 0. */
export function maxDrawdown(values) {
  let peak = -Infinity, peakIdx = 0, best = { dd: 0, peakIdx: 0, troughIdx: 0 };
  for (let i = 0; i < values.length; i++) {
    if (values[i] > peak) { peak = values[i]; peakIdx = i; }
    const dd = peak > 0 ? values[i] / peak - 1 : 0;
    if (dd < best.dd) best = { dd, peakIdx, troughIdx: i };
  }
  return best;
}

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Date -> value lookup carrying the last value forward (and back to the first, for a
// series that opens a day or two into the window).
function lookup(rows) {
  const dates = rows.map(r => r.date), vals = rows.map(r => r.value);
  return date => {
    let lo = 0, hi = dates.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= date) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx >= 0 ? vals[idx] : vals.length ? vals[0] : null;
  };
}

/**
 * Exchange-rate helper over stored history: `mult(from, to, date)` is what one unit of
 * `from` is worth in `to` on that date. USD/KRW is Yahoo's KRW=X where it exists and
 * FRED's DEXKOUS before; JPY/KRW is Yahoo's JPYKRW=X, or DEXKOUS / DEXJPUS before.
 */
export function fxConverter(rowsBySeries) {
  const splice = (primary, secondary) => {
    const firstPrimary = primary[0]?.date;
    return [...secondary.filter(r => !firstPrimary || r.date < firstPrimary), ...primary];
  };
  const fredJpy = lookup(rowsBySeries.get('FRED:DEXJPUS') || []);
  const fredKrw = rowsBySeries.get('FRED:DEXKOUS') || [];
  const krwPerUsd = lookup(splice(rowsBySeries.get('KRW=X') || [], fredKrw));
  const fredJpyKrw = fredKrw.map(r => ({ date: r.date, value: r.value / fredJpy(r.date) })).filter(r => Number.isFinite(r.value));
  const krwPerJpy = lookup(splice(rowsBySeries.get('JPYKRW=X') || [], fredJpyKrw));
  const toKrw = (ccy, date) => (ccy === 'KRW' ? 1 : ccy === 'USD' ? krwPerUsd(date) : ccy === 'JPY' ? krwPerJpy(date) : null);
  return (from, to, date) => {
    if (from === to) return 1;
    const a = toKrw(from, date), b = toKrw(to, date);
    return a && b ? a / b : 1; // an unsupported currency stays at face, as elsewhere in the app
  };
}

// Weekly (Friday-keyed) returns of a { date, value } series, optionally restated by `mult(date)`.
function weeklyReturns(rows, mult = () => 1) {
  const byWeek = new Map();
  for (const r of rows) {
    const d = new Date(`${r.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
    byWeek.set(d.toISOString().slice(0, 10), r.value * mult(r.date));
  }
  const series = [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, close]) => ({ date, close }));
  return toReturns(series).map;
}

const PRIOR_SD = 0.5;    // a holding is expected to track its chosen proxy one-for-one, ± this
const BETA_YEARS = 3;    // window for the beta between a holding and its proxy
const MIN_WEEKS = 26;

/**
 * Beta of `own` to `proxy`, both restated into `ccy`, on weekly returns over the most
 * recent BETA_YEARS where both exist. With `shrink`, pulled toward 1 by its standard error
 * (the proxy was picked to track the holding); without, the raw estimate. Returns
 * { beta, se, n } — beta 1 when there's too little overlap to measure.
 */
function proxyBeta(ownRows, proxyRows, ownMult, proxyMult, shrink) {
  if (!ownRows.length || !proxyRows.length) return { beta: 1, se: null, n: 0 };
  const from = shiftDate(ownRows[ownRows.length - 1].date, -365 * BETA_YEARS);
  const r = regress(
    weeklyReturns(ownRows.filter(x => x.date >= from), ownMult),
    weeklyReturns(proxyRows.filter(x => x.date >= from), proxyMult),
    MIN_WEEKS,
  );
  if (r.beta == null) return { beta: 1, se: null, n: r.n };
  if (!shrink) return { beta: r.beta, se: r.se_beta, n: r.n };
  const wData = 1 / r.se_beta ** 2, wPrior = 1 / PRIOR_SD ** 2;
  return { beta: (wData * r.beta + wPrior) / (wData + wPrior), se: Math.sqrt(1 / (wData + wPrior)), n: r.n };
}

async function loadRows(seriesList, from, to) {
  const out = new Map(seriesList.map(s => [s, []]));
  if (!seriesList.length) return out;
  const rows = await query(
    `SELECT series, DATE_FORMAT(trade_date, '%Y-%m-%d') AS d, value
       FROM scenario_history
      WHERE series IN (${seriesList.map(() => '?').join(',')}) AND trade_date BETWEEN ? AND ?
      ORDER BY trade_date ASC`,
    [...seriesList, from, to]
  );
  for (const r of rows) out.get(r.series).push({ date: r.d, value: Number(r.value) });
  return out;
}

export async function loadCoverage(seriesList) {
  const coverage = new Map();
  if (!seriesList.length) return coverage;
  const rows = await query(
    `SELECT series, DATE_FORMAT(MIN(trade_date), '%Y-%m-%d') AS first, DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS last
       FROM scenario_history WHERE series IN (${seriesList.map(() => '?').join(',')}) GROUP BY series`,
    seriesList
  );
  for (const r of rows) coverage.set(r.series, { first: r.first, last: r.last });
  return coverage;
}

/**
 * Replay one event over every portfolio.
 *   portfolios: [{ id, name, holdings: [{ symbol, display_name, is_cash, currency, value }] }]
 *               with `value` today's worth in `currency` (the display currency)
 *   meta:       Map symbol -> { market, currency } for non-cash holdings
 * Returns { event, dates, portfolios: [...], indexes: [...] } — see the route for the shape.
 */
export async function replayEvent(event, portfolios, meta, currency, basis = 'factor') {
  const held = [...meta.keys()];
  const chains = new Map(held.map(s => [s, chainFor(s, meta.get(s).market, basis)]));
  const allSeries = [...new Set([...held, ...[...chains.values()].flat(), ...referenceSeries()])];
  const coverage = await loadCoverage(allSeries);

  const end = event.end || coverage.get(FALLBACK_INDEX)?.last;
  if (!end) throw new Error('No stored history for the replay — run scripts/load-scenario-history.js');
  const start = event.start;

  // Event-window prices for every candidate series, padded a little so the first day has a
  // value to carry forward.
  const win = await loadRows(allSeries, shiftDate(start, -10), end);
  const fxWin = fxConverter(win);

  // Where each holding's path comes from.
  const plan = new Map();
  for (const sym of held) {
    const src = pickSource(chains.get(sym), win, start, end);
    plan.set(sym, src === sym ? { kind: 'own', series: sym } : src ? { kind: 'proxy', series: src } : { kind: 'fallback', series: FALLBACK_INDEX });
  }
  const windowSeries = [...new Set([...[...plan.values()].map(p => p.series), '^GSPC', '^IXIC', '^KS11'])];

  // Recent history for the betas between each holding and its proxy (or the fallback index).
  const betaSeries = new Set(FX_SERIES);
  for (const [sym, p] of plan) if (p.kind !== 'own') { betaSeries.add(sym); betaSeries.add(p.series); }
  const recentFrom = shiftDate(coverage.get(FALLBACK_INDEX)?.last || end, -365 * BETA_YEARS - 14);
  const recent = await loadRows([...betaSeries], recentFrom, '9999-12-31');
  const fxRecent = fxConverter(recent);
  for (const [sym, p] of plan) {
    if (p.kind === 'own') continue;
    const hcy = meta.get(sym).currency;
    if (p.series === 'TBILL') { p.beta = 1; continue; } // cash-like: no market beta to measure
    const pcy = seriesCurrency(p.series);
    const b = proxyBeta(recent.get(sym) || [], recent.get(p.series) || [], () => 1, d => fxRecent(pcy, hcy, d), p.kind === 'proxy');
    p.beta = b.beta; p.beta_se = b.se; p.weeks = b.n;
  }

  // Trading-day axis: every date any used price series has inside the window.
  const axisSet = new Set();
  for (const s of windowSeries) {
    for (const r of win.get(s)) if (r.date >= start && r.date <= end) axisSet.add(r.date);
  }
  const dates = [...axisSet].sort();
  if (dates.length < 2) throw new Error(`Not enough stored history between ${start} and ${end}`);
  const at = new Map(windowSeries.map(s => [s, lookup(win.get(s))]));
  const t0 = dates[0];

  // A holding's path in the display currency, as value multiples of day one.
  const pathCache = new Map();
  const holdingPath = (h) => {
    const key = h.is_cash ? `CASH:${h.currency}` : h.symbol;
    if (pathCache.has(key)) return pathCache.get(key);
    const hcy = h.currency;
    const fx0 = fxWin(hcy, currency, t0);
    let local;
    if (h.is_cash) local = () => 1;
    else {
      const p = plan.get(h.symbol);
      const get = at.get(p.series);
      if (p.kind === 'own') {
        const v0 = get(t0);
        local = d => get(d) / v0;
      } else {
        const pcy = seriesCurrency(p.series);
        const v0 = get(t0) * fxWin(pcy, hcy, t0);
        local = d => Math.pow((get(d) * fxWin(pcy, hcy, d)) / v0, p.beta);
      }
    }
    const path = dates.map(d => local(d) * fxWin(hcy, currency, d) / fx0);
    pathCache.set(key, path);
    return path;
  };

  const sourceOf = (h) => {
    if (h.is_cash) return { kind: 'cash' };
    const p = plan.get(h.symbol);
    return {
      kind: p.kind, series: p.series, name: SERIES_NAMES[p.series] || p.series,
      beta: p.beta ?? null, beta_se: p.beta_se ?? null,
    };
  };

  const outPortfolios = portfolios.map(pf => {
    const rows = new Map();
    const total = new Array(dates.length).fill(0);
    for (const h of pf.holdings) {
      const path = holdingPath(h);
      for (let i = 0; i < dates.length; i++) total[i] += h.value * path[i];
      const label = h.is_cash ? `Cash ${h.currency}` : h.symbol;
      const row = rows.get(label) || {
        label, symbol: h.symbol, display_name: h.is_cash ? 'Cash' : h.display_name, is_cash: h.is_cash,
        source: sourceOf(h), current: 0, end_value: 0,
        end_return: path[path.length - 1] - 1, worst_return: Math.min(...path) - 1,
      };
      row.current += h.value;
      row.end_value += h.value * path[path.length - 1];
      rows.set(label, row);
    }
    const current = pf.holdings.reduce((a, h) => a + h.value, 0);
    const dd = maxDrawdown(total);
    return {
      id: pf.id, name: pf.name, current,
      end_value: total[total.length - 1],
      end_return: current > 0 ? total[total.length - 1] / current - 1 : 0,
      max_drawdown: dd.dd, dd_peak: dates[dd.peakIdx], dd_trough: dates[dd.troughIdx],
      path: total.map(v => (current > 0 ? +(v / current - 1).toFixed(5) : 0)),
      holdings: [...rows.values()].sort((a, b) => b.current - a.current),
    };
  });

  // What the reference markets did over the window, for the summary line. Read from their
  // own rows, not the axis: bitcoin's weekends belong on the axis only when one is held.
  const indexes = SUMMARY_INDEXES.map(s => {
    if (!coversWindow(win.get(s), start, end)) return { series: s, name: SERIES_NAMES[s], change: null };
    const get = lookup(win.get(s));
    return { series: s, name: SERIES_NAMES[s], change: get(dates[dates.length - 1]) / get(t0) - 1 };
  });
  const won = fxWin('KRW', 'USD', dates[dates.length - 1]) / fxWin('KRW', 'USD', t0) - 1;

  return {
    event: { ...event, end, first_date: t0, last_date: dates[dates.length - 1] },
    currency, basis, dates, indexes, won_vs_usd: won,
    portfolios: outPortfolios,
  };
}
