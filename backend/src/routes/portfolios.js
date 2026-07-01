import express from 'express';
import { query } from '../db.js';
import { ensureTrackedInstrument } from '../services/instrumentService.js';
import { fetchQuotes } from '../services/priceFetcher.js';
import { TRADING_DAYS, riskStats, toReturns, pearsonMaps } from '../services/stats.js';

export const portfoliosRouter = express.Router();

const MAX_HOLDINGS = 30;

// Cash equivalents are stored as holdings with a reserved symbol `CASH:<CCY>` (no
// instrument row); they're valued 1:1 in their currency. Supported cash currencies
// match the app's base currencies.
const CASH_CURRENCIES = ['USD', 'KRW'];
const cashSymbol = ccy => `CASH:${ccy}`;
const isCash = sym => typeof sym === 'string' && sym.startsWith('CASH:');
const cashCurrency = sym => sym.slice(5);

// Analytics window defaults (mirrors /analytics): trailing days, capped at 5y.
const ANALYTICS_DEFAULT_DAYS = 365;
const ANALYTICS_MAX_DAYS = 1825;
const clampAnalyticsDays = raw => Math.min(Number(raw || ANALYTICS_DEFAULT_DAYS), ANALYTICS_MAX_DAYS);

// Cache the live FX rate briefly so back-to-back portfolio reads don't each hit Yahoo.
const FX_TTL_MS = 60_000;
let fxCache = { rate: null, at: 0 };

// Latest USD/KRW (KRW per USD) for converting holding values to a common base.
// Prefers the live Yahoo quote so conversions use the current rate, falling back
// to the most recent stored EOD close if the live lookup is unavailable.
async function getKrwPerUsd() {
  const now = Date.now();
  if (fxCache.rate && now - fxCache.at < FX_TTL_MS) return fxCache.rate;

  try {
    const q = await fetchQuotes(['KRW=X']);
    const live = q['KRW=X']?.price;
    if (live && live > 0) { fxCache = { rate: Number(live), at: now }; return fxCache.rate; }
  } catch { /* fall back to the stored close below */ }

  const rows = await query(
    `SELECT lp.close_px FROM instruments i
       JOIN v_latest_prices lp ON lp.instrument_id = i.id
      WHERE i.symbol = 'KRW=X'`
  );
  const rate = rows[0] ? Number(rows[0].close_px) : null;
  if (rate) fxCache = { rate, at: now };
  return rate;
}

// Local-time 'YYYY-MM-DD' for a Date (server's timezone), used to date holding changes.
function dateOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function convert(amount, currency, base, krwPerUsd) {
  if (amount == null) return null;
  if (currency === base) return amount;
  if (!krwPerUsd) return amount; // can't convert; treat 1:1 (shouldn't happen — KRW=X is seeded)
  if (base === 'USD' && currency === 'KRW') return amount / krwPerUsd;
  if (base === 'KRW' && currency === 'USD') return amount * krwPerUsd;
  return amount;
}

// Holdings with latest + historical closes for one portfolio.
async function loadHoldings(portfolioId) {
  return query(
    `SELECT h.id, h.symbol, h.account, h.shares, h.cost_price, h.currency,
            i.id AS instrument_id, i.display_name,
            lp.close_px AS latest_close, lp.trade_date AS latest_date,
            (SELECT close_px FROM prices p WHERE p.instrument_id = i.id AND p.trade_date < MAKEDATE(YEAR(CURDATE()), 1) ORDER BY p.trade_date DESC LIMIT 1) AS close_ytd,
            (SELECT close_px FROM prices p WHERE p.instrument_id = i.id AND p.trade_date <= DATE_SUB(CURDATE(), INTERVAL 1 YEAR) ORDER BY p.trade_date DESC LIMIT 1) AS close_1y,
            (SELECT close_px FROM prices p WHERE p.instrument_id = i.id AND p.trade_date <= DATE_SUB(CURDATE(), INTERVAL 3 YEAR) ORDER BY p.trade_date DESC LIMIT 1) AS close_3y,
            (SELECT close_px FROM prices p WHERE p.instrument_id = i.id AND p.trade_date <= DATE_SUB(CURDATE(), INTERVAL 5 YEAR) ORDER BY p.trade_date DESC LIMIT 1) AS close_5y
       FROM portfolio_holdings h
       LEFT JOIN instruments i ON i.symbol = h.symbol COLLATE utf8mb4_unicode_ci
       LEFT JOIN v_latest_prices lp ON lp.instrument_id = i.id
      WHERE h.portfolio_id = ?
      ORDER BY h.symbol ASC`,
    [portfolioId]
  );
}

// Enrich each holding with value/returns and roll up portfolio-level returns.
// Per-holding window returns are native-currency price returns (FX-independent);
// the portfolio figure is the realized return of holding every position for the
// window — i.e. each holding's return weighted by its value at the START of the
// window, computed as (sum of end values) / (sum of start values) - 1. Weighting
// by *current* value would overweight winners and bias the number upward.
export function computePortfolio(rows, base, krwPerUsd) {
  const holdings = rows.map(r => {
    const shares = Number(r.shares);

    // Cash: face value in its own currency, no price history, flat (zero) return.
    if (isCash(r.symbol)) {
      const ccy = cashCurrency(r.symbol);
      const mvBase = convert(shares, ccy, base, krwPerUsd);
      return {
        id: r.id,
        symbol: r.symbol,
        account: r.account || '',
        display_name: 'Cash',
        currency: ccy,
        is_cash: true,
        shares,
        cost_price: 1,
        latest_close: 1,
        latest_date: null,
        market_value: shares,
        market_value_base: mvBase,
        cost_basis_base: mvBase,
        return_inception: 0,
        return_ytd: null,
        return_1y: null,
        return_3y: null,
        return_5y: null,
      };
    }

    const latest = r.latest_close != null ? Number(r.latest_close) : null;
    const cost = Number(r.cost_price);
    const mvNative = latest != null ? shares * latest : null;
    const mvBase = convert(mvNative, r.currency, base, krwPerUsd);
    const costBase = convert(shares * cost, r.currency, base, krwPerUsd);
    const ret = (then) => (latest != null && then != null && Number(then) > 0 ? latest / Number(then) - 1 : null);
    return {
      id: r.id,
      symbol: r.symbol,
      account: r.account || '',
      display_name: r.display_name,
      currency: r.currency,
      shares,
      cost_price: cost,
      latest_close: latest,
      latest_date: r.latest_date,
      market_value: mvNative,
      market_value_base: mvBase,
      cost_basis_base: costBase,
      return_inception: cost > 0 && latest != null ? latest / cost - 1 : null,
      return_ytd: ret(r.close_ytd),
      return_1y: ret(r.close_1y),
      return_3y: ret(r.close_3y),
      return_5y: ret(r.close_5y),
    };
  });

  const totalValue = holdings.reduce((a, h) => a + (h.market_value_base || 0), 0);
  const totalCost = holdings.reduce((a, h) => a + (h.cost_basis_base || 0), 0);
  for (const h of holdings) h.weight = totalValue > 0 ? (h.market_value_base || 0) / totalValue : null;

  // Inception return is securities-only — cash is flat (gain 0) and would just
  // dilute the percentage toward zero. Market Value / Cost Basis / Gain above keep
  // cash in (cash adds equally to both, so Gain is unaffected).
  const secValue = holdings.reduce((a, h) => a + (h.is_cash ? 0 : h.market_value_base || 0), 0);
  const secCost = holdings.reduce((a, h) => a + (h.is_cash ? 0 : h.cost_basis_base || 0), 0);

  // Realized buy-and-hold return over a price window: sum each holding's
  // base-currency value at the window start (shares × start close) and at the end
  // (shares × latest close), then take end/start − 1. This is equivalent to
  // weighting each holding's return by its START-of-window value, which is the
  // correct weighting (current-value weighting overweights winners). FX-neutral:
  // both endpoints convert at today's rate, matching the per-holding returns.
  const cashValue = totalValue - secValue;
  // Returns { sec, withCash }: securities-only window return, and the same with cash
  // folded in as a flat (zero-return) sleeve — cash adds equally to the window's start
  // and end values, so it dilutes the percentage toward zero.
  const windowReturn = (closeKey) => {
    let startSum = 0, endSum = 0;
    for (const r of rows) {
      const latest = r.latest_close != null ? Number(r.latest_close) : null;
      const then = r[closeKey] != null ? Number(r[closeKey]) : null;
      if (latest == null || then == null || !(then > 0)) continue;
      const shares = Number(r.shares);
      startSum += convert(shares * then, r.currency, base, krwPerUsd);
      endSum += convert(shares * latest, r.currency, base, krwPerUsd);
    }
    return {
      sec: startSum > 0 ? endSum / startSum - 1 : null,
      withCash: startSum + cashValue > 0 ? (endSum + cashValue) / (startSum + cashValue) - 1 : null,
    };
  };
  const ytd = windowReturn('close_ytd');

  return {
    holdings,
    totals: {
      base_currency: base,
      market_value: totalValue,
      cost_basis: totalCost,
      // Securities vs. cash split (base currency) so the cards can show cash separately.
      // Cash is valued at face, so its market value and cost basis are the same number.
      securities_value: secValue,
      securities_cost: secCost,
      cash_value: totalValue - secValue,
      gain: totalValue - totalCost,
      return_inception: secCost > 0 ? secValue / secCost - 1 : null,
      // Cash-inclusive variants (cash folded in flat) — shown as a subtle secondary figure.
      return_inception_with_cash: totalCost > 0 ? totalValue / totalCost - 1 : null,
      return_ytd: ytd.sec,
      return_ytd_with_cash: ytd.withCash,
      return_1y: windowReturn('close_1y').sec,
      return_3y: windowReturn('close_3y').sec,
      return_5y: windowReturn('close_5y').sec,
    },
  };
}

// Walk every priced trading day from the first holding change onward, reconstructing
// the holdings in effect that day from the change log and valuing them at that day's
// close (converted to base at that day's FX). Shared by the daily and monthly views.
//
//   events:   [{ id, holding_id, symbol, name, instrument_id, currency, shares, action,
//                effective_date:'YYYY-MM-DD' }]. action 'set' adds/updates a lot to
//             `shares`; 'delete' removes it.
//   priceRows:[{ instrument_id, date:'YYYY-MM-DD', close }]   daily closes
//   fxRows:   [{ date:'YYYY-MM-DD', fx }]                     daily KRW per USD
//
// Returns { days: [{ date, total, breakdown:Map(symbol->value) }], nameBySymbol }
// with one entry per priced day. Lots of the same symbol are combined per day.
function walkDailyValues(events, priceRows, fxRows, base) {
  // Cash equivalents are excluded from the value chart — it tracks invested securities
  // only, so an idle cash band doesn't dominate or distort the trend.
  events = events.filter(e => !isCash(e.symbol));
  if (events.length === 0) return { days: [], nameBySymbol: new Map() };

  // Daily close per instrument + daily FX, each with an as-of (latest <= d) lookup so
  // a day a given instrument didn't trade (e.g. a one-market holiday) still values.
  const priceByInst = new Map(); // instrument_id -> { dates:[sorted], byDate:Map }
  for (const r of priceRows) {
    let e = priceByInst.get(r.instrument_id);
    if (!e) { e = { byDate: new Map() }; priceByInst.set(r.instrument_id, e); }
    e.byDate.set(r.date, Number(r.close));
  }
  for (const e of priceByInst.values()) e.dates = [...e.byDate.keys()].sort();
  const fxByDate = new Map(fxRows.map(r => [r.date, Number(r.fx)]));
  const fxDates = [...fxByDate.keys()].sort();

  const asOf = (dates, byDate, d) => {
    if (byDate.has(d)) return byDate.get(d);
    let lo = 0, hi = dates.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (dates[mid] <= d) { best = dates[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best == null ? null : byDate.get(best);
  };
  const priceAsOf = (instId, d) => { const e = priceByInst.get(instId); return e ? asOf(e.dates, e.byDate, d) : null; };
  const fxAsOf = (d) => asOf(fxDates, fxByDate, d);

  // Trading days to value: every priced day from the first change onward.
  const firstDate = events.reduce((m, e) => (e.effective_date < m ? e.effective_date : m), events[0].effective_date);
  const dayset = new Set();
  for (const e of priceByInst.values()) for (const d of e.dates) if (d >= firstDate) dayset.add(d);
  const allDays = [...dayset].sort();

  const sorted = [...events].sort((a, b) =>
    a.effective_date < b.effective_date ? -1 : a.effective_date > b.effective_date ? 1 : (a.id ?? 0) - (b.id ?? 0));

  const current = new Map();      // holding_id -> { symbol, instrument_id, currency, shares }
  const nameBySymbol = new Map();
  const days = [];
  let ei = 0;

  for (const d of allDays) {
    // Apply every change that has taken effect by day d (last write wins per lot).
    while (ei < sorted.length && sorted[ei].effective_date <= d) {
      const ev = sorted[ei++];
      if (ev.action === 'delete') current.delete(ev.holding_id);
      else current.set(ev.holding_id, { symbol: ev.symbol, instrument_id: ev.instrument_id, currency: ev.currency, shares: Number(ev.shares) });
      if (ev.name) nameBySymbol.set(ev.symbol, ev.name);
    }
    if (current.size === 0) continue;

    const fx = fxAsOf(d);
    const breakdown = new Map();
    let total = 0, priced = false;
    for (const h of current.values()) {
      const px = priceAsOf(h.instrument_id, d);
      if (px == null || (h.currency !== base && fx == null)) continue; // can't value this lot today
      const v = convert(h.shares * px, h.currency, base, fx);
      breakdown.set(h.symbol, (breakdown.get(h.symbol) || 0) + v);
      total += v; priced = true;
    }
    if (!priced) continue; // no priced holdings this day
    days.push({ date: d, total, breakdown });
  }

  return { days, nameBySymbol };
}

// Shape per-period rows ([{ [labelKey]: x, total, breakdown:Map }]) into the stacked
// chart payload: { symbols:[{key,symbol,name}], points:[{ [labelKey], total, [key]:value }] }.
// Series are every symbol that ever appears, ordered by the latest period's value.
function buildSeries(rows, labelKey, nameBySymbol) {
  if (rows.length === 0) return { symbols: [], points: [] };
  const last = rows.at(-1).breakdown;
  const allSyms = new Set();
  for (const r of rows) for (const sym of r.breakdown.keys()) allSyms.add(sym);
  const ordered = [...allSyms].sort((a, b) => (last.get(b) ?? 0) - (last.get(a) ?? 0));
  const symbols = ordered.map((sym, i) => ({ key: `s${i}`, symbol: sym, name: nameBySymbol.get(sym) || sym }));
  const keyBySym = new Map(ordered.map((sym, i) => [sym, `s${i}`]));
  const points = rows.map(r => {
    const point = { [labelKey]: r[labelKey], total: r.total };
    for (const [sym, val] of r.breakdown) point[keyBySym.get(sym)] = val;
    return point;
  });
  return { symbols, points };
}

// Month-by-month AVERAGE total asset value, composition-aware: each bar is the mean of
// the month's daily totals, so both intra-month buys/sells and daily price moves show.
// Returns { symbols, points:[{ month, total, [key]:avgValue }] }.
export function monthlyAverageValues(events, priceRows, fxRows, base) {
  if (!events || events.length === 0) return { symbols: [], points: [] };
  const { days, nameBySymbol } = walkDailyValues(events, priceRows, fxRows, base);

  const monthAgg = new Map(); // ym -> { count, total, bySymbol:Map(symbol->sum) }
  for (const day of days) {
    const ym = day.date.slice(0, 7);
    let agg = monthAgg.get(ym);
    if (!agg) { agg = { count: 0, total: 0, bySymbol: new Map() }; monthAgg.set(ym, agg); }
    agg.count++; agg.total += day.total;
    for (const [sym, v] of day.breakdown) agg.bySymbol.set(sym, (agg.bySymbol.get(sym) || 0) + v);
  }

  const rows = [...monthAgg.keys()].sort().map(ym => {
    const agg = monthAgg.get(ym);
    const breakdown = new Map();
    for (const [sym, sum] of agg.bySymbol) breakdown.set(sym, sum / agg.count);
    return { month: ym, total: agg.total / agg.count, breakdown };
  });
  return buildSeries(rows, 'month', nameBySymbol);
}

// Day-by-day total asset value, composition-aware: each bar is one trading day's close
// total. Returns { symbols, points:[{ date, total, [key]:value }] }.
export function dailyValues(events, priceRows, fxRows, base) {
  if (!events || events.length === 0) return { symbols: [], points: [] };
  const { days, nameBySymbol } = walkDailyValues(events, priceRows, fxRows, base);
  return buildSeries(days, 'date', nameBySymbol);
}

// Append a holding-change event to the log, dated today (server local time). `action`
// is 'set' (a lot's resulting shares) or 'delete' (the lot was removed). This is what
// lets the value chart reconstruct month-over-month history automatically.
async function recordHistory(portfolioId, { holding_id, symbol, account, shares, currency, action }) {
  await query(
    `INSERT INTO holding_history (portfolio_id, holding_id, symbol, account, shares, currency, action, effective_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [portfolioId, holding_id ?? null, symbol, account ?? '', shares ?? 0, currency ?? 'USD', action, dateOf(new Date())]
  );
}

// The full holding-change log for a portfolio, joined to instruments for pricing.
async function loadHistory(portfolioId) {
  return query(
    `SELECT hh.id, hh.holding_id, hh.symbol, hh.account, hh.shares, hh.currency, hh.action,
            DATE_FORMAT(hh.effective_date, '%Y-%m-%d') AS effective_date,
            i.id AS instrument_id, i.display_name AS name
       FROM holding_history hh
       LEFT JOIN instruments i ON i.symbol = hh.symbol COLLATE utf8mb4_unicode_ci
      WHERE hh.portfolio_id = ?
      ORDER BY hh.effective_date ASC, hh.id ASC`,
    [portfolioId]
  );
}

/** List all portfolios with rolled-up returns. */
portfoliosRouter.get('/', async (_req, res, next) => {
  try {
    const portfolios = await query(`SELECT id, name, base_currency, created_at FROM portfolios ORDER BY created_at DESC`);
    const krwPerUsd = await getKrwPerUsd();
    const out = [];
    for (const p of portfolios) {
      const rows = await loadHoldings(p.id);
      const { totals } = computePortfolio(rows, p.base_currency, krwPerUsd);
      out.push({ ...p, holdings_count: rows.length, ...totals });
    }
    res.json({ count: out.length, portfolios: out });
  } catch (e) { next(e); }
});

/** Create a portfolio. Body: { name, base_currency? } */
portfoliosRouter.post('/', async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const base = ['USD', 'KRW'].includes(req.body?.base_currency) ? req.body.base_currency : 'USD';
    const r = await query(`INSERT INTO portfolios (name, base_currency) VALUES (?, ?)`, [name, base]);
    res.status(201).json({ id: r.insertId, name, base_currency: base });
  } catch (e) { next(e); }
});

/** Portfolio detail with holdings + returns. */
portfoliosRouter.get('/:id', async (req, res, next) => {
  try {
    const rows = await query(`SELECT id, name, base_currency, created_at FROM portfolios WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Portfolio not found' });
    const p = rows[0];
    const krwPerUsd = await getKrwPerUsd();
    const holdingRows = await loadHoldings(p.id);
    const { holdings, totals } = computePortfolio(holdingRows, p.base_currency, krwPerUsd);
    res.json({ ...p, max_holdings: MAX_HOLDINGS, krw_per_usd: krwPerUsd, holdings, totals });
  } catch (e) { next(e); }
});

/**
 * Composition-aware total asset value for the stacked value chart, reconstructed from
 * the holding change log. `?granularity=daily` returns one point per trading day (each
 * day's close total); the default `monthly` returns each month's average across its
 * trading days. Returns { base_currency, granularity, symbols, points } — daily points
 * carry a `date`, monthly points a `month`.
 */
portfoliosRouter.get('/:id/value-history', async (req, res, next) => {
  try {
    const pf = await query(`SELECT id, base_currency FROM portfolios WHERE id = ?`, [req.params.id]);
    if (pf.length === 0) return res.status(404).json({ error: 'Portfolio not found' });
    const base = pf[0].base_currency;
    const granularity = req.query.granularity === 'daily' ? 'daily' : 'monthly';

    const events = await loadHistory(req.params.id);
    if (events.length === 0) return res.json({ base_currency: base, granularity, symbols: [], points: [] });

    const minDate = events[0].effective_date; // ordered by effective_date asc
    const instIds = [...new Set(events.map(e => e.instrument_id).filter(Boolean))];
    let priceRows = [];
    if (instIds.length > 0) {
      const placeholders = instIds.map(() => '?').join(',');
      priceRows = await query(
        `SELECT instrument_id, DATE_FORMAT(trade_date, '%Y-%m-%d') AS date, close_px AS close
           FROM prices
          WHERE instrument_id IN (${placeholders}) AND trade_date >= ?
          ORDER BY trade_date ASC`,
        [...instIds, minDate]
      );
    }
    // Daily USD/KRW for converting cross-currency holdings to the base.
    const fxRows = await query(
      `SELECT DATE_FORMAT(p.trade_date, '%Y-%m-%d') AS date, p.close_px AS fx
         FROM prices p JOIN instruments i ON i.id = p.instrument_id
        WHERE i.symbol = 'KRW=X' AND p.trade_date >= ?
        ORDER BY p.trade_date ASC`,
      [minDate]
    );

    const { symbols, points } = granularity === 'daily'
      ? dailyValues(events, priceRows, fxRows, base)
      : monthlyAverageValues(events, priceRows, fxRows, base);
    res.json({ base_currency: base, granularity, symbols, points });
  } catch (e) { next(e); }
});

/**
 * Per-portfolio analytics: return/risk stats and a correlation matrix of daily
 * returns over the holdings' distinct instruments. Same shape as /analytics, but
 * scoped to this portfolio. Query params: ?days=365 (capped 1825), ?rf=0.
 */
portfoliosRouter.get('/:id/analytics', async (req, res, next) => {
  try {
    const pf = await query(`SELECT id FROM portfolios WHERE id = ?`, [req.params.id]);
    if (pf.length === 0) return res.status(404).json({ error: 'Portfolio not found' });

    const days = clampAnalyticsDays(req.query.days);
    const rf = Number(req.query.rf || 0);

    // Distinct symbols held (multiple lots/accounts of the same ticker collapse to one).
    const symRows = await query(`SELECT DISTINCT symbol FROM portfolio_holdings WHERE portfolio_id = ?`, [req.params.id]);
    const symbols = symRows.map(r => r.symbol);
    if (symbols.length === 0) {
      return res.json({ days, rf, trading_days: TRADING_DAYS, count: 0, assets: [], correlation: { symbols: [], matrix: [] } });
    }

    const placeholders = symbols.map(() => '?').join(',');
    const rows = await query(
      `SELECT i.symbol, i.display_name, i.market, i.currency, p.trade_date, p.close_px
         FROM instruments i
         JOIN prices p ON p.instrument_id = i.id
        WHERE i.symbol IN (${placeholders})
          AND p.trade_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        ORDER BY i.symbol ASC, p.trade_date ASC`,
      [...symbols, days]
    );

    // Group by symbol -> ordered { date, close } series.
    const bySymbol = new Map();
    for (const r of rows) {
      const s = bySymbol.get(r.symbol) || { meta: r, series: [] };
      s.series.push({ date: (r.trade_date instanceof Date ? r.trade_date.toISOString() : String(r.trade_date)).slice(0, 10), close: Number(r.close_px) });
      bySymbol.set(r.symbol, s);
    }

    const assets = [];
    const returnsBySymbol = new Map();
    for (const [symbol, { meta, series }] of bySymbol) {
      const stats = riskStats(series, rf);
      if (!stats) continue;
      returnsBySymbol.set(symbol, toReturns(series).map);
      assets.push({ symbol, display_name: meta.display_name, market: meta.market, currency: meta.currency, ...stats });
    }

    assets.sort((a, b) => (a.market === b.market ? a.symbol.localeCompare(b.symbol) : a.market.localeCompare(b.market)));
    const statSymbols = assets.map(a => a.symbol);
    const matrix = statSymbols.map((sa, i) =>
      statSymbols.map((sb, j) => (i === j ? 1 : pearsonMaps(returnsBySymbol.get(sa), returnsBySymbol.get(sb))))
    );

    res.json({
      days, rf, trading_days: TRADING_DAYS, count: assets.length,
      note: 'Daily simple returns, annualized with √252. Sharpe/Sortino use the arithmetic annualized mean; CAGR/total return are realized.',
      assets,
      correlation: { symbols: statSymbols, matrix },
    });
  } catch (e) { next(e); }
});

/** Rename a portfolio. Body: { name } */
portfoliosRouter.patch('/:id', async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const r = await query(`UPDATE portfolios SET name = ? WHERE id = ?`, [name, req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Portfolio not found' });
    res.json({ id: Number(req.params.id), name });
  } catch (e) { next(e); }
});

/** Delete a portfolio. Refused unless it's empty — all holdings must be removed first. */
portfoliosRouter.delete('/:id', async (req, res, next) => {
  try {
    const pf = await query(`SELECT id FROM portfolios WHERE id = ?`, [req.params.id]);
    if (pf.length === 0) return res.status(404).json({ error: 'Portfolio not found' });

    const [{ n }] = await query(`SELECT COUNT(*) AS n FROM portfolio_holdings WHERE portfolio_id = ?`, [req.params.id]);
    if (Number(n) > 0) {
      return res.status(409).json({ error: `Remove all ${n} holding${n > 1 ? 's' : ''} before deleting this portfolio` });
    }

    const r = await query(`DELETE FROM portfolios WHERE id = ?`, [req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Portfolio not found' });
    res.json({ deleted: 1 });
  } catch (e) { next(e); }
});

/**
 * Add / update a holding. Body: { symbol, shares, price? }
 * price defaults to the latest close; the ticker is auto-tracked & backfilled if new.
 * The change is logged (effective today) so the value history tracks it month over month.
 */
portfoliosRouter.post('/:id/holdings', async (req, res, next) => {
  try {
    const pid = req.params.id;
    const pf = await query(`SELECT id FROM portfolios WHERE id = ?`, [pid]);
    if (pf.length === 0) return res.status(404).json({ error: 'Portfolio not found' });

    const shares = Number(req.body?.shares);
    if (!Number.isFinite(shares) || shares <= 0) return res.status(400).json({ error: 'shares must be a positive number' });

    // Optional account label — lets the same ticker be held more than once per
    // portfolio (one lot per account). Same symbol + same account = edit.
    const account = (req.body?.account || '').trim().slice(0, 64);

    let inst, latestClose;
    try {
      const r = await ensureTrackedInstrument(req.body?.symbol);
      inst = r.instrument; latestClose = r.latest_close;
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }

    // Capacity check (existing symbol+account = edit, allowed even at the cap).
    const existing = await query(`SELECT id FROM portfolio_holdings WHERE portfolio_id = ? AND symbol = ? AND account = ?`, [pid, inst.symbol, account]);
    if (existing.length === 0) {
      // Cash equivalents don't count toward the securities cap.
      const [{ n }] = await query(`SELECT COUNT(*) AS n FROM portfolio_holdings WHERE portfolio_id = ? AND symbol NOT LIKE 'CASH:%'`, [pid]);
      if (Number(n) >= MAX_HOLDINGS) return res.status(400).json({ error: `Portfolio is full (max ${MAX_HOLDINGS} holdings)` });
    }

    const priceInput = req.body?.price != null && req.body.price !== '' ? Number(req.body.price) : null;
    const price = priceInput != null && priceInput > 0 ? priceInput : latestClose;
    if (price == null || !(price > 0)) return res.status(400).json({ error: 'No price available — provide a custom price' });

    await query(
      `INSERT INTO portfolio_holdings (portfolio_id, symbol, account, shares, cost_price, currency)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE shares = VALUES(shares), cost_price = VALUES(cost_price), currency = VALUES(currency)`,
      [pid, inst.symbol, account, shares, price, inst.currency]
    );

    // Log the resulting lot (its id is stable across edits via the unique key).
    const [row] = await query(
      `SELECT id FROM portfolio_holdings WHERE portfolio_id = ? AND symbol = ? AND account = ?`,
      [pid, inst.symbol, account]
    );
    await recordHistory(pid, { holding_id: row?.id, symbol: inst.symbol, account, shares, currency: inst.currency, action: 'set' });

    res.status(201).json({ symbol: inst.symbol, account, shares, cost_price: price, currency: inst.currency, latest_close: latestClose });
  } catch (e) { next(e); }
});

/**
 * Add / update a cash equivalent. Body: { currency:'USD'|'KRW', amount, account? }
 * Stored as a holding with the reserved symbol CASH:<CCY> (shares = amount, cost 1),
 * so it flows through valuation, weights, and the value-history chart like any lot.
 * Same currency + same account = edit. Edit the amount later via PATCH /holdings (shares).
 */
portfoliosRouter.post('/:id/cash', async (req, res, next) => {
  try {
    const pid = req.params.id;
    const pf = await query(`SELECT id FROM portfolios WHERE id = ?`, [pid]);
    if (pf.length === 0) return res.status(404).json({ error: 'Portfolio not found' });

    const currency = String(req.body?.currency || '').toUpperCase();
    if (!CASH_CURRENCIES.includes(currency)) return res.status(400).json({ error: `currency must be one of ${CASH_CURRENCIES.join(', ')}` });

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

    const account = (req.body?.account || '').trim().slice(0, 64);
    const symbol = cashSymbol(currency);

    await query(
      `INSERT INTO portfolio_holdings (portfolio_id, symbol, account, shares, cost_price, currency)
       VALUES (?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE shares = VALUES(shares), currency = VALUES(currency)`,
      [pid, symbol, account, amount, currency]
    );

    const [row] = await query(
      `SELECT id FROM portfolio_holdings WHERE portfolio_id = ? AND symbol = ? AND account = ?`,
      [pid, symbol, account]
    );
    await recordHistory(pid, { holding_id: row?.id, symbol, account, shares: amount, currency, action: 'set' });

    res.status(201).json({ symbol, currency, account, amount });
  } catch (e) { next(e); }
});

/** Update a holding's shares, cost price, and/or account. Body: { shares?, cost_price?, account? } */
portfoliosRouter.patch('/:id/holdings/:holdingId', async (req, res, next) => {
  try {
    const sets = [];
    const params = [];
    const { shares, cost_price, account } = req.body || {};
    if (shares !== undefined) {
      const n = Number(shares);
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'shares must be a positive number' });
      sets.push('shares = ?'); params.push(n);
    }
    if (cost_price !== undefined && cost_price !== '') {
      const c = Number(cost_price);
      if (!Number.isFinite(c) || c <= 0) return res.status(400).json({ error: 'cost_price must be a positive number' });
      sets.push('cost_price = ?'); params.push(c);
    }
    if (account !== undefined) {
      // Account may be blank (clears the label); keyed by (portfolio_id, symbol, account).
      sets.push('account = ?'); params.push(String(account).trim().slice(0, 64));
    }
    if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
    params.push(req.params.holdingId, req.params.id);
    let r;
    try {
      r = await query(`UPDATE portfolio_holdings SET ${sets.join(', ')} WHERE id = ? AND portfolio_id = ?`, params);
    } catch (e) {
      // Renaming the account onto a symbol+account that already exists in this portfolio.
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This ticker is already held under that account — change the account or merge the lots.' });
      throw e;
    }
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Holding not found' });

    // Log the lot's resulting state so the value history reflects the change this month.
    const [row] = await query(
      `SELECT symbol, account, shares, currency FROM portfolio_holdings WHERE id = ? AND portfolio_id = ?`,
      [req.params.holdingId, req.params.id]
    );
    if (row) await recordHistory(req.params.id, { holding_id: Number(req.params.holdingId), symbol: row.symbol, account: row.account, shares: row.shares, currency: row.currency, action: 'set' });

    res.json({ updated: 1 });
  } catch (e) { next(e); }
});

/** Remove a holding from a portfolio. Logs a 'delete' so the value history stops counting it. */
portfoliosRouter.delete('/:id/holdings/:holdingId', async (req, res, next) => {
  try {
    const [row] = await query(
      `SELECT symbol, account, shares, currency FROM portfolio_holdings WHERE id = ? AND portfolio_id = ?`,
      [req.params.holdingId, req.params.id]
    );
    const r = await query(`DELETE FROM portfolio_holdings WHERE id = ? AND portfolio_id = ?`, [req.params.holdingId, req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Holding not found' });
    if (row) await recordHistory(req.params.id, { holding_id: Number(req.params.holdingId), symbol: row.symbol, account: row.account, shares: 0, currency: row.currency, action: 'delete' });
    res.json({ deleted: 1 });
  } catch (e) { next(e); }
});
