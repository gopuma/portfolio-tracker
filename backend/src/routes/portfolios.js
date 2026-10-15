import express from 'express';
import { query, withTransaction } from '../db.js';
import { ensureTrackedInstrument } from '../services/instrumentService.js';
import { fetchQuotes } from '../services/priceFetcher.js';
import { TRADING_DAYS, riskStats, toReturns, pearsonMaps } from '../services/stats.js';
import { loadTransactions, transactionsToEvents, rederivePortfolioHoldings, findOversell } from '../services/ledgerService.js';
import {
  HttpError, badRequest, parseId, parseTradeDate, parseShares, parsePrice, parseAccount, provided, todayLocal,
  MIN_PRICE, MAX_PRICE, MIN_SHARES,
} from '../validation.js';

export const portfoliosRouter = express.Router();

const MAX_HOLDINGS = 30;

// Cash equivalents are stored as holdings with a reserved symbol `CASH:<CCY>` (no
// instrument row); they're valued 1:1 in their currency. Supported cash currencies
// match the app's base currencies.
const CASH_CURRENCIES = ['USD', 'KRW', 'JPY'];
const cashSymbol = ccy => `CASH:${ccy}`;
const isCash = sym => typeof sym === 'string' && sym.startsWith('CASH:');
const cashCurrency = sym => sym.slice(5);
// Fixed bottom-to-top order for the cash block in the value chart, so a given currency
// always sits in the same place (and takes the same shade of the cash ramp).
const CASH_STACK_ORDER = ['KRW', 'USD', 'JPY'];

// Analytics window defaults (mirrors /analytics): trailing days, capped at 5y.
const ANALYTICS_DEFAULT_DAYS = 365;
const ANALYTICS_MAX_DAYS = 1825;
const clampAnalyticsDays = raw => Math.min(Number(raw || ANALYTICS_DEFAULT_DAYS), ANALYTICS_MAX_DAYS);

// Cache the live FX rates briefly so back-to-back portfolio reads don't each hit Yahoo.
const FX_TTL_MS = 60_000;
const fxCache = new Map(); // symbol -> { rate, at }

// Latest close for one FX pair. Prefers the live Yahoo quote so conversions use the
// current rate, falling back to the most recent stored EOD close if that's unavailable.
async function getFxRate(symbol) {
  const now = Date.now();
  const hit = fxCache.get(symbol);
  if (hit && hit.rate && now - hit.at < FX_TTL_MS) return hit.rate;

  try {
    const q = await fetchQuotes([symbol]);
    const live = q[symbol]?.price;
    if (live && live > 0) { fxCache.set(symbol, { rate: Number(live), at: now }); return Number(live); }
  } catch { /* fall back to the stored close below */ }

  const rows = await query(
    `SELECT lp.close_px FROM instruments i
       JOIN v_latest_prices lp ON lp.instrument_id = i.id
      WHERE i.symbol = ?`,
    [symbol]
  );
  const rate = rows[0] ? Number(rows[0].close_px) : null;
  if (rate) fxCache.set(symbol, { rate, at: now });
  return rate;
}

// KRW per USD — the pivot rate every conversion routes through.
const getKrwPerUsd = () => getFxRate('KRW=X');
// KRW per JPY, for yen-denominated cash and securities.
const getKrwPerJpy = () => getFxRate('JPYKRW=X');

/** Both rates at once, in the shape `convert` expects. */
export async function getFxRates() {
  const [krwPerUsd, krwPerJpy] = await Promise.all([getKrwPerUsd(), getKrwPerJpy()]);
  return { krwPerUsd, krwPerJpy };
}

// Local-time 'YYYY-MM-DD' for a Date (server's timezone), used to date holding changes.
function dateOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Convert between the supported currencies, pivoting through KRW so every pair works
 * from the two rates we track (KRW=X = KRW per USD, JPYKRW=X = KRW per JPY).
 *
 * `rates` is { krwPerUsd, krwPerJpy }; a bare number is read as krwPerUsd, which is what
 * the day-by-day chart walk passes when it only has that day's USD/KRW close.
 *
 * An unsupported currency, or a missing rate for the pair in hand, returns the amount
 * unconverted — the long-standing behaviour, so a stray EUR/BRL holding is counted at
 * face rather than dropped.
 */
function convert(amount, currency, base, rates) {
  if (amount == null) return null;
  if (currency === base) return amount;
  const { krwPerUsd, krwPerJpy } = typeof rates === 'number' ? { krwPerUsd: rates } : (rates || {});
  const toKrw = (amt, ccy) => {
    if (ccy === 'KRW') return amt;
    if (ccy === 'USD') return krwPerUsd ? amt * krwPerUsd : null;
    if (ccy === 'JPY') return krwPerJpy ? amt * krwPerJpy : null;
    return null; // unsupported currency
  };
  const fromKrw = (krw, ccy) => {
    if (krw == null) return null;
    if (ccy === 'KRW') return krw;
    if (ccy === 'USD') return krwPerUsd ? krw / krwPerUsd : null;
    if (ccy === 'JPY') return krwPerJpy ? krw / krwPerJpy : null;
    return null;
  };
  const out = fromKrw(toKrw(amount, currency), base);
  return out == null ? amount : out;
}

// Holdings with latest + historical closes for one portfolio.
export async function loadHoldings(portfolioId) {
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
export function computePortfolio(rows, base, fx) {
  const holdings = rows.map(r => {
    const shares = Number(r.shares);

    // Cash: face value in its own currency, no price history, flat (zero) return.
    if (isCash(r.symbol)) {
      const ccy = cashCurrency(r.symbol);
      const mvBase = convert(shares, ccy, base, fx);
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
    const mvBase = convert(mvNative, r.currency, base, fx);
    const costBase = convert(shares * cost, r.currency, base, fx);
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
      startSum += convert(shares * then, r.currency, base, fx);
      endSum += convert(shares * latest, r.currency, base, fx);
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
//   backfillFrom: 'YYYY-MM-DD' | null — see below.
//   fxJpyRows:[{ date:'YYYY-MM-DD', fx }]                     daily KRW per JPY (optional;
//             only needed when a yen-denominated holding is in play)
//
// BACKFILL. With `backfillFrom` set, priced days from that date up to the first real
// change are also valued, using the composition as of that first change held constant —
// "what this portfolio would have been worth through 2025, at the shares I opened with".
// Only prices and FX move; nothing is written to the ledger, and those days are tagged
// `backfill: true` so the UI can mark them as hypothetical rather than recorded. A lot
// whose instrument had not listed yet simply has no price and drops out of those days.
//
// Returns { days: [{ date, total, fx, breakdown:Map(symbol->value) }], nameBySymbol }
// with one entry per priced day (`fx` is that day's KRW-per-USD rate used to convert,
// null when unknown). Lots of the same symbol are combined per day.
function walkDailyValues(events, priceRows, fxRows, base, backfillFrom = null, fxJpyRows = []) {
  // Cash rides in only when the caller asked for it (loadHistory decides); if it didn't,
  // there are no CASH:<CCY> events here to begin with.
  if (!events || events.length === 0) return { days: [], nameBySymbol: new Map() };

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
  const jpyByDate = new Map((fxJpyRows || []).map(r => [r.date, Number(r.fx)]));
  const jpyDates = [...jpyByDate.keys()].sort();

  const asOf = (dates, byDate, d) => {
    if (byDate.has(d)) return byDate.get(d);
    let lo = 0, hi = dates.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (dates[mid] <= d) { best = dates[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best == null ? null : byDate.get(best);
  };
  const priceAsOf = (instId, d) => { const e = priceByInst.get(instId); return e ? asOf(e.dates, e.byDate, d) : null; };
  const fxAsOf = (d) => asOf(fxDates, fxByDate, d);
  const jpyAsOf = (d) => (jpyDates.length ? asOf(jpyDates, jpyByDate, d) : null);

  const sorted = [...events].sort((a, b) =>
    a.effective_date < b.effective_date ? -1 : a.effective_date > b.effective_date ? 1 : (a.id ?? 0) - (b.id ?? 0));

  // Trading days to value: from the first change onward, or from the backfill start if
  // one was asked for and it reaches further back.
  const firstDate = sorted[0].effective_date;
  const from = backfillFrom && backfillFrom < firstDate ? backfillFrom : firstDate;
  const dayset = new Set();
  for (const e of priceByInst.values()) for (const d of e.dates) if (d >= from) dayset.add(d);
  const allDays = [...dayset].sort();

  // Each lot's opening size and the date its own history begins.
  const opening = new Map();  // holding_id -> lot
  const lotStart = new Map(); // holding_id -> 'YYYY-MM-DD'
  for (const ev of sorted) {
    if (lotStart.has(ev.holding_id) || ev.action === 'delete') continue;
    lotStart.set(ev.holding_id, ev.effective_date);
    opening.set(ev.holding_id, {
      symbol: ev.symbol, instrument_id: ev.instrument_id, currency: ev.currency, shares: Number(ev.shares),
    });
  }

  // The portfolio's OPENING DATE: the day the most lots begin, earliest wins a tie. That's
  // the bulk import (or first sit-down) that established the position, and it's the
  // composition the backfill projects backwards.
  //
  // Two rules fall out of it, and both matter:
  //   · a lot starting BEFORE it (an RSU vest dated to when it really vested) keeps its own
  //     real history, while the rest of the stack is still projected alongside — so the
  //     chart doesn't collapse to that single lot for the months before the bulk begins;
  //   · a lot starting AFTER it was genuinely bought later and is NEVER projected back —
  //     it appears on its own date, which is what makes the backfill a record of the
  //     position you opened with rather than of the one you hold now.
  const startCounts = new Map();
  for (const d of lotStart.values()) startCounts.set(d, (startCounts.get(d) || 0) + 1);
  let openingDate = firstDate;
  for (const [d, n] of [...startCounts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (n > (startCounts.get(openingDate) || 0)) openingDate = d;
  }

  const current = new Map();      // holding_id -> { symbol, instrument_id, currency, shares }
  const nameBySymbol = new Map();
  const ccyBySymbol = new Map();  // the currency a symbol's price is quoted in
  const days = [];
  let ei = 0;

  // Value one composition on one day. Returns null if nothing could be priced.
  const valueDay = (holdings, d) => {
    const fx = fxAsOf(d);
    const rates = { krwPerUsd: fx, krwPerJpy: jpyAsOf(d) };
    const breakdown = new Map();
    // Cash only: the balance in the currency it's actually held in, carried alongside the
    // converted figure so the UI can show "₩617,643,519 → $460,567" and leave no doubt
    // about which number is in which unit.
    const native = new Map();
    // Share count per symbol (summed across its lots), so the chart can print volume
    // inside a bar segment when few enough holdings are selected to have room.
    const shares = new Map();
    let total = 0, priced = false;
    for (const h of holdings.values()) {
      // Cash is worth its face amount in its own currency — no price history to look up.
      const cash = isCash(h.symbol);
      const px = cash ? 1 : priceAsOf(h.instrument_id, d);
      if (px == null || (h.currency !== base && fx == null)) continue; // can't value this lot today
      const v = convert(h.shares * px, h.currency, base, rates);
      breakdown.set(h.symbol, (breakdown.get(h.symbol) || 0) + v);
      if (!cash) shares.set(h.symbol, (shares.get(h.symbol) || 0) + h.shares);
      if (cash) native.set(h.symbol, (native.get(h.symbol) || 0) + h.shares);
      total += v; priced = true;
    }
    // Carry the day's FX rate so the chart can show how much of a move is currency.
    return priced ? { total, fx: fx ?? null, breakdown, native, shares } : null;
  };

  // Names and quote currencies come from the events regardless of which day a lot starts.
  for (const ev of sorted) {
    if (ev.name) nameBySymbol.set(ev.symbol, ev.name);
    if (ev.currency) ccyBySymbol.set(ev.symbol, ev.currency);
  }
  const projecting = !!(backfillFrom && backfillFrom < firstDate);

  for (const d of allDays) {
    // Apply every change that has taken effect by day d (last write wins per lot).
    while (ei < sorted.length && sorted[ei].effective_date <= d) {
      const ev = sorted[ei++];
      if (ev.action === 'delete') current.delete(ev.holding_id);
      else current.set(ev.holding_id, { symbol: ev.symbol, instrument_id: ev.instrument_id, currency: ev.currency, shares: Number(ev.shares) });
    }

    // Backfill: before the opening date, any lot of the opening position that hasn't started
    // yet rides along at its opening size. A day carrying one is synthetic and flagged.
    let holdings = current, synthetic = false;
    if (projecting && d < openingDate) {
      for (const [id, start] of lotStart) {
        if (d >= start || start > openingDate) continue; // already real, or bought later
        if (!synthetic) { holdings = new Map(current); synthetic = true; }
        holdings.set(id, opening.get(id));
      }
    }
    if (holdings.size === 0) continue;

    const v = valueDay(holdings, d);
    if (!v) continue; // no priced holdings this day
    days.push(synthetic ? { date: d, ...v, backfill: true } : { date: d, ...v });
  }

  return { days, nameBySymbol, ccyBySymbol };
}

// Shape per-period rows ([{ [labelKey]: x, total, fx, breakdown:Map }]) into the stacked
// chart payload: { symbols:[{key,symbol,name}], points:[{ [labelKey], total, fx, [key]:value }] }.
// Series are every symbol that ever appears, ordered by the latest period's value.
function buildSeries(rows, labelKey, nameBySymbol, ccyBySymbol = new Map()) {
  if (rows.length === 0) return { symbols: [], points: [] };
  const last = rows.at(-1).breakdown;
  const allSyms = new Set();
  for (const r of rows) for (const sym of r.breakdown.keys()) allSyms.add(sym);
  // Cash is emitted as one contiguous block at the bottom of the stack, in a fixed currency
  // order, so it reads as a single base section under the securities instead of its
  // currencies being scattered through them by size. Securities keep size ordering.
  const cashSyms = [...allSyms].filter(isCash).sort((a, b) => {
    const rank = c => { const i = CASH_STACK_ORDER.indexOf(cashCurrency(c)); return i < 0 ? 99 : i; };
    return rank(a) - rank(b);
  });
  const secSyms = [...allSyms].filter(s => !isCash(s)).sort((a, b) => (last.get(b) ?? 0) - (last.get(a) ?? 0));
  const ordered = [...cashSyms, ...secSyms];
  const symbols = ordered.map((sym, i) => ({
    key: `s${i}`, symbol: sym, name: nameBySymbol.get(sym) || sym,
    currency: ccyBySymbol.get(sym) || null, // the unit its price is quoted in
  }));
  const keyBySym = new Map(ordered.map((sym, i) => [sym, `s${i}`]));
  const points = rows.map(r => {
    const point = { [labelKey]: r[labelKey], total: r.total, fx: r.fx ?? null };
    // Only tagged on synthetic (backfilled) periods, so real history stays untouched.
    if (r.backfill) point.backfill = true;
    for (const [sym, val] of r.breakdown) point[keyBySym.get(sym)] = val;
    // Cash only, and only where there is one: { <seriesKey>: faceAmountInItsOwnCurrency }.
    if (r.native && r.native.size > 0) {
      point.native = {};
      for (const [sym, amt] of r.native) point.native[keyBySym.get(sym)] = amt;
    }
    // Securities only: the share count behind each segment, for the on-bar volume label.
    if (r.shares && r.shares.size > 0) {
      point.shares = {};
      for (const [sym, n] of r.shares) point.shares[keyBySym.get(sym)] = n;
    }
    return point;
  });
  return { symbols, points };
}

// Month-by-month total asset value, composition-aware. SECURITIES are the mean of their
// daily values across the month, so both intra-month trades and daily price moves show.
// CASH is the month's CLOSING balance instead — a bank balance isn't a thing you average,
// and doing so made a fresh deposit read at a fraction of its size in the part-elapsed
// current month. `total` is the sum of the bands as drawn, so it matches the stack either
// way. Returns { symbols, points:[{ month, total, fx, [key]:value }] } — `fx` is the
// month's average KRW-per-USD rate, the currency component behind the bar's move.
export function monthlyAverageValues(events, priceRows, fxRows, base, backfillFrom = null, fxJpyRows = []) {
  if (!events || events.length === 0) return { symbols: [], points: [] };
  const { days, nameBySymbol, ccyBySymbol } = walkDailyValues(events, priceRows, fxRows, base, backfillFrom, fxJpyRows);

  const monthAgg = new Map(); // ym -> { count, fxSum, fxCount, backfill, bySymbol, lastCash, lastNative }
  for (const day of days) {
    const ym = day.date.slice(0, 7);
    let agg = monthAgg.get(ym);
    if (!agg) {
      agg = {
        count: 0, fxSum: 0, fxCount: 0, backfill: false,
        bySymbol: new Map(), lastCash: new Map(), lastNative: new Map(), lastShares: new Map(),
      };
      monthAgg.set(ym, agg);
    }
    agg.count++;
    // A month straddling the backfill boundary is part hypothetical, so flag the whole bar.
    if (day.backfill) agg.backfill = true;
    // Average the month's FX the same way as its value, over the days that had a rate.
    if (day.fx != null) { agg.fxSum += day.fx; agg.fxCount++; }
    for (const [sym, v] of day.breakdown) {
      if (isCash(sym)) continue; // cash is closing-balance, handled below
      agg.bySymbol.set(sym, (agg.bySymbol.get(sym) || 0) + v);
    }
    // Cash takes the month's CLOSING balance, not its average: a balance is a balance, and
    // averaging one over a part-elapsed month understates money you actually hold (a deposit
    // on the 9th would otherwise show at a third of its size). `days` is date-ordered, so
    // replacing the snapshot each day leaves the last day's. Replacing rather than merging
    // matters — a balance withdrawn to zero must disappear, not linger from an earlier day.
    agg.lastCash = new Map([...day.breakdown].filter(([sym]) => isCash(sym)));
    agg.lastNative = new Map(day.native || []);
    // Volume is a count, so like cash it takes the month's CLOSING position.
    agg.lastShares = new Map(day.shares || []);
  }

  const rows = [...monthAgg.keys()].sort().map(ym => {
    const agg = monthAgg.get(ym);
    const breakdown = new Map();
    for (const [sym, sum] of agg.bySymbol) breakdown.set(sym, sum / agg.count);
    for (const [sym, v] of agg.lastCash) breakdown.set(sym, v);
    // Total is the sum of the bands as drawn, so the on-bar figure always matches the stack.
    let total = 0;
    for (const v of breakdown.values()) total += v;
    return {
      month: ym, total, breakdown, native: agg.lastNative, shares: agg.lastShares,
      fx: agg.fxCount ? agg.fxSum / agg.fxCount : null,
      backfill: agg.backfill,
    };
  });
  return buildSeries(rows, 'month', nameBySymbol, ccyBySymbol);
}

// Day-by-day total asset value, composition-aware: each bar is one trading day's close
// total. Returns { symbols, points:[{ date, total, fx, [key]:value }] } — `fx` is that
// day's KRW-per-USD rate.
export function dailyValues(events, priceRows, fxRows, base, backfillFrom = null, fxJpyRows = []) {
  if (!events || events.length === 0) return { symbols: [], points: [] };
  const { days, nameBySymbol, ccyBySymbol } = walkDailyValues(events, priceRows, fxRows, base, backfillFrom, fxJpyRows);
  return buildSeries(days, 'date', nameBySymbol, ccyBySymbol);
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

// Composition change-log for the value chart, derived from the transaction ledger: each
// trade becomes a `set` (cumulative shares as of its trade_date). Correctly dated by each
// trade's real trade_date. `includeCash` also folds deposits/withdrawals in as running
// CASH:<CCY> balances; without it the chart stays securities-only.
async function loadHistory(portfolioId, includeCash = false) {
  const txns = await loadTransactions(portfolioId);
  const wanted = txns.filter(t =>
    t.side === 'buy' || t.side === 'sell' || (includeCash && (t.side === 'deposit' || t.side === 'withdraw')));
  if (wanted.length === 0) return [];
  // Only real securities have instrument rows; CASH:<CCY> is a reserved synthetic symbol.
  const symbols = [...new Set(wanted.filter(t => !isCash(t.symbol)).map(t => t.symbol))];
  let instIdBySymbol = {}, nameBySymbol = {};
  if (symbols.length > 0) {
    const placeholders = symbols.map(() => '?').join(',');
    const instRows = await query(
      `SELECT symbol, id, display_name FROM instruments WHERE symbol IN (${placeholders})`,
      symbols
    );
    instIdBySymbol = Object.fromEntries(instRows.map(r => [r.symbol, r.id]));
    nameBySymbol = Object.fromEntries(instRows.map(r => [r.symbol, r.display_name]));
  }
  return transactionsToEvents(wanted, nameBySymbol, instIdBySymbol, includeCash);
}

/** List all portfolios with rolled-up returns. */
portfoliosRouter.get('/', async (_req, res, next) => {
  try {
    const portfolios = await query(`SELECT id, name, base_currency, created_at FROM portfolios ORDER BY created_at DESC`);
    const fx = await getFxRates();
    const out = [];
    for (const p of portfolios) {
      const rows = await loadHoldings(p.id);
      const { totals } = computePortfolio(rows, p.base_currency, fx);
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
    const fx = await getFxRates();
    const holdingRows = await loadHoldings(p.id);
    const { holdings, totals } = computePortfolio(holdingRows, p.base_currency, fx);
    // Both rates go to the client so it can mirror the same conversions locally.
    res.json({
      ...p, max_holdings: MAX_HOLDINGS,
      krw_per_usd: fx.krwPerUsd, krw_per_jpy: fx.krwPerJpy,
      holdings, totals,
    });
  } catch (e) { next(e); }
});

/**
 * Composition-aware total asset value for the stacked value chart, reconstructed from
 * the holding change log. `?granularity=daily` returns one point per trading day (each
 * day's close total); the default `monthly` returns each month's average across its
 * trading days. Returns { base_currency, granularity, symbols, points } — daily points
 * carry a `date`, monthly points a `month`, and every point carries the `fx` (KRW per USD)
 * that valued it, so the chart can show the exchange rate behind each bar.
 *
 * `?backfill_from=YYYY-MM-DD` prepends synthetic periods from that date up to the first
 * recorded trade, valuing the opening composition at each day's real close and FX (see
 * walkDailyValues). Those points come back tagged `backfill: true`, and the echoed
 * `backfill_from` is null when the request asked for a date the ledger already covers.
 * Nothing is written: the ledger, cost basis and returns are untouched by this.
 *
 * `?include_cash=1` folds cash balances in as extra `CASH:<CCY>` series, each valued at
 * face in its own currency and converted at the same daily rate as everything else — so a
 * monthly bar carries the month's averaged conversion and a daily bar that day's.
 */
portfoliosRouter.get('/:id/value-history', async (req, res, next) => {
  try {
    const pf = await query(`SELECT id, base_currency FROM portfolios WHERE id = ?`, [req.params.id]);
    if (pf.length === 0) return res.status(404).json({ error: 'Portfolio not found' });
    // Display currency: default to the portfolio's base, overridable via ?currency=USD|KRW.
    // Conversion uses each day's FX rate (loaded below), so it's historically accurate.
    const base = ['USD', 'KRW'].includes(req.query.currency) ? req.query.currency : pf[0].base_currency;
    const granularity = req.query.granularity === 'daily' ? 'daily' : 'monthly';
    // Optional synthetic pre-history start. Only a well-formed past date is honoured.
    const asked = String(req.query.backfill_from || '');
    const backfillFrom = /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= dateOf(new Date()) ? asked : null;
    const includeCash = req.query.include_cash === '1' || req.query.include_cash === 'true';

    const events = await loadHistory(req.params.id, includeCash);
    if (events.length === 0) {
      return res.json({ base_currency: base, granularity, backfill_from: null, include_cash: includeCash, symbols: [], points: [] });
    }

    const minDate = events[0].effective_date; // ordered by effective_date asc
    // A backfill start only counts if it actually predates the ledger; when it does, the
    // price/FX loads below have to reach back that far too.
    const backfill = backfillFrom && backfillFrom < minDate ? backfillFrom : null;
    const loadFrom = backfill || minDate;
    const instIds = [...new Set(events.map(e => e.instrument_id).filter(Boolean))];
    let priceRows = [];
    if (instIds.length > 0) {
      const placeholders = instIds.map(() => '?').join(',');
      priceRows = await query(
        `SELECT instrument_id, DATE_FORMAT(trade_date, '%Y-%m-%d') AS date, close_px AS close
           FROM prices
          WHERE instrument_id IN (${placeholders}) AND trade_date >= ?
          ORDER BY trade_date ASC`,
        [...instIds, loadFrom]
      );
    }
    // Daily USD/KRW for converting cross-currency holdings to the base.
    const fxRows = await query(
      `SELECT DATE_FORMAT(p.trade_date, '%Y-%m-%d') AS date, p.close_px AS fx
         FROM prices p JOIN instruments i ON i.id = p.instrument_id
        WHERE i.symbol = 'KRW=X' AND p.trade_date >= ?
        ORDER BY p.trade_date ASC`,
      [loadFrom]
    );
    // Live rate for the LATEST bar only: override (or fill in) the FX on the most recent
    // trading day with the live KRW/USD quote, so the current bar reflects today's rate
    // even before that day's FX close is stored. Historical bars keep each day's own rate.
    const liveKrwPerUsd = await getKrwPerUsd();
    if (liveKrwPerUsd && priceRows.length > 0) {
      const latestPriceDate = priceRows.reduce((m, r) => (r.date > m ? r.date : m), priceRows[0].date);
      fxRows.push({ date: latestPriceDate, fx: liveKrwPerUsd }); // appended → wins in fxByDate
    }
    // Daily KRW/JPY, loaded only when a yen-denominated holding actually needs it.
    let fxJpyRows = [];
    if (events.some(e => e.currency === 'JPY')) {
      fxJpyRows = await query(
        `SELECT DATE_FORMAT(p.trade_date, '%Y-%m-%d') AS date, p.close_px AS fx
           FROM prices p JOIN instruments i ON i.id = p.instrument_id
          WHERE i.symbol = 'JPYKRW=X' AND p.trade_date >= ?
          ORDER BY p.trade_date ASC`,
        [loadFrom]
      );
    }

    const { symbols, points } = granularity === 'daily'
      ? dailyValues(events, priceRows, fxRows, base, backfill, fxJpyRows)
      : monthlyAverageValues(events, priceRows, fxRows, base, backfill, fxJpyRows);
    res.json({ base_currency: base, granularity, backfill_from: backfill, include_cash: includeCash, symbols, points });
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


// --- Transaction-ledger helpers ------------------------------------------------
//
// Every ledger write runs through withPortfolioLock: one DB transaction that first takes a
// row lock on the portfolio, then writes the ledger, re-derives the holdings cache, and
// checks the result. Concurrent writes to the same portfolio (a double-click, two tabs)
// queue behind the lock instead of both passing the oversell check, and any failure —
// a rejected oversell, a DB error, a crash mid-way — rolls the whole change back, so the
// ledger and the holdings cache can't drift apart.
//
// Anything slow or networked (Yahoo lookup, price backfill) happens BEFORE taking the lock.

async function withPortfolioLock(pid, fn) {
  return withTransaction(async q => {
    const [pf] = await q(`SELECT id FROM portfolios WHERE id = ? FOR UPDATE`, [pid]);
    if (!pf) throw new HttpError(404, 'Portfolio not found');
    return fn(q);
  });
}

// Cheap existence check for routes that must do network work before taking the lock.
async function assertPortfolioExists(pid) {
  const rows = await query(`SELECT id FROM portfolios WHERE id = ?`, [pid]);
  if (rows.length === 0) throw new HttpError(404, 'Portfolio not found');
}

async function addTransaction(q, pid, { symbol, account, side, shares, price, currency, trade_date }) {
  const r = await q(
    `INSERT INTO transactions (portfolio_id, symbol, account, side, shares, price, currency, trade_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [pid, symbol, account || '', side, shares, price ?? 1, currency || 'USD', trade_date]
  );
  return r.insertId;
}

// Latest stored close for a symbol, or null when there isn't a usable one.
async function latestClose(symbol, q = query) {
  const rows = await q(
    `SELECT lp.close_px AS close_px FROM instruments i JOIN v_latest_prices lp ON lp.instrument_id = i.id WHERE i.symbol = ?`,
    [symbol]
  );
  const px = rows[0] ? Number(rows[0].close_px) : NaN;
  return px > 0 ? px : null;
}

// Price for a trade the app books on the user's behalf (a share-count edit, a removal):
// the market's latest close. Falls back to the lot's average cost only when no close is
// stored at all (e.g. a delisted ticker), and refuses rather than inventing a price.
async function marketPriceFor(row, q) {
  const px = (await latestClose(row.symbol, q)) ?? Number(row.cost_price);
  if (!(px >= MIN_PRICE)) throw badRequest(`No price available for ${row.symbol} — record the trade with an explicit price instead.`);
  return px;
}

const fmtShares = n => n.toLocaleString('en-US', { maximumFractionDigits: 6 });

// Re-derive the holdings cache from the ledger (on the transaction's connection) and
// enforce the ledger invariant: no securities lot may go short at ANY point in its
// history — not just at the end. Throwing rolls the caller's whole write back. Returns
// negative-cash (margin) balances as warnings, which are allowed.
async function rederiveAndCheck(q, pid) {
  const { cashLots, txns } = await rederivePortfolioHoldings(pid, q);
  const short = findOversell(txns);
  if (short) {
    const lot = `${short.symbol}${short.account ? ` (${short.account})` : ''}`;
    throw badRequest(
      `That would oversell ${lot}: it would hold ${fmtShares(short.shares)} shares on ${short.trade_date}. ` +
      `You can't hold negative shares — check the trade dates and the buys that fund each sell.`
    );
  }
  return cashLots.filter(c => c.shares < -1e-9).map(c =>
    `Cash ${c.symbol.slice(5)}${c.account ? ` (${c.account})` : ''} is negative (margin): ${Math.round(c.shares).toLocaleString()}`);
}

/**
 * Rewrite a lot's buy prices so its derived average cost equals `target`.
 *
 * Cost basis is derived from the ledger (average cost over the buys), so it can't just be
 * written to the holdings cache — the next re-derive would overwrite it. Instead the buys
 * are rescaled by target/currentAvg, which lands the average exactly on target while
 * keeping the relative shape of the purchase history. When the current average is zero (or
 * unusable) every buy is set flat to the target instead.
 *
 * Only prices change, never shares — so the value chart, which reads share counts alone,
 * is unaffected. Must run inside the caller's transaction (`q`) so a failure part-way
 * can't leave the lot half-rescaled. Returns the number of ledger rows touched.
 */
async function setLotAverageCost(q, portfolioId, symbol, account, target) {
  const buys = await q(
    `SELECT id, shares, price FROM transactions
      WHERE portfolio_id = ? AND symbol = ? AND account = ? AND side = 'buy'
      ORDER BY trade_date ASC, id ASC`,
    [portfolioId, symbol, account || '']
  );
  if (buys.length === 0) return 0;

  const totalShares = buys.reduce((s, b) => s + Number(b.shares), 0);
  const totalCost = buys.reduce((s, b) => s + Number(b.shares) * Number(b.price), 0);
  const currentAvg = totalShares > 0 ? totalCost / totalShares : 0;
  const scale = currentAvg > 0 ? target / currentAvg : null;

  const repriced = buys.map(b => ({ id: b.id, price: scale != null ? Number(b.price) * scale : target }));
  // A skewed purchase history can push one rescaled buy outside what the column stores
  // (below 0.0001 it would silently round to 0).
  if (repriced.some(b => !(b.price >= MIN_PRICE && b.price <= MAX_PRICE))) {
    throw badRequest(`Can't set the average cost to ${target}: rescaling this lot's buys would put a purchase price out of range. Edit the individual transactions instead.`);
  }
  for (const b of repriced) {
    await q(`UPDATE transactions SET price = ? WHERE id = ?`, [b.price, b.id]);
  }
  return buys.length;
}

/**
 * Add a holding = record a BUY in the ledger (accumulates). Body: { symbol, shares, price?,
 * account?, trade_date?, avg_cost? }. Holdings/chart/cash derive from the ledger.
 *
 * `price` is what these particular shares cost (default: the latest close); the lot's
 * average is then recomputed over every buy. `avg_cost` instead states what the average
 * should be AFTER this purchase — for when your broker's average is the number you
 * trust — and is applied last. The ticker is auto-tracked & backfilled if new.
 */
portfoliosRouter.post('/:id/holdings', async (req, res, next) => {
  try {
    const pid = parseId(req.params.id, 'Portfolio');
    const shares = parseShares(req.body?.shares);
    const account = parseAccount(req.body?.account);
    const trade_date = parseTradeDate(req.body?.trade_date, { fallback: todayLocal() });
    const priceInput = provided(req.body?.price) ? parsePrice(req.body.price) : null;
    const avgCost = provided(req.body?.avg_cost) ? parsePrice(req.body.avg_cost, 'avg_cost') : null;

    await assertPortfolioExists(pid);
    const { instrument: inst, latest_close: latestCloseVal } = await ensureTrackedInstrument(req.body?.symbol);
    const price = priceInput ?? latestCloseVal;
    if (!(price >= MIN_PRICE)) throw badRequest('No price available — provide a custom price');

    const warnings = await withPortfolioLock(pid, async q => {
      // Capacity check only when introducing a NEW distinct security lot.
      const existing = await q(`SELECT 1 FROM portfolio_holdings WHERE portfolio_id = ? AND symbol = ? AND account = ?`, [pid, inst.symbol, account]);
      if (existing.length === 0) {
        const [{ n }] = await q(`SELECT COUNT(*) AS n FROM portfolio_holdings WHERE portfolio_id = ? AND symbol NOT LIKE 'CASH:%'`, [pid]);
        if (Number(n) >= MAX_HOLDINGS) throw badRequest(`Portfolio is full (max ${MAX_HOLDINGS} holdings)`);
      }
      await addTransaction(q, pid, { symbol: inst.symbol, account, side: 'buy', shares, price, currency: inst.currency, trade_date });
      if (avgCost == null) return rederiveAndCheck(q, pid);
      // Pin the lot's resulting average rather than letting it fall out of the buys.
      await setLotAverageCost(q, pid, inst.symbol, account, avgCost);
      return rederiveAndCheck(q, pid);
    });

    res.status(201).json({ symbol: inst.symbol, account, shares, cost_price: avgCost ?? price, currency: inst.currency, latest_close: latestCloseVal, warnings });
  } catch (e) { next(e); }
});

/** Add cash = record a DEPOSIT. Body: { currency:'USD'|'KRW'|'JPY', amount, account?, trade_date? } */
portfoliosRouter.post('/:id/cash', async (req, res, next) => {
  try {
    const pid = parseId(req.params.id, 'Portfolio');
    const currency = String(req.body?.currency || '').toUpperCase();
    if (!CASH_CURRENCIES.includes(currency)) throw badRequest(`currency must be one of ${CASH_CURRENCIES.join(', ')}`);
    const amount = parseShares(req.body?.amount, 'amount');
    const account = parseAccount(req.body?.account);
    const trade_date = parseTradeDate(req.body?.trade_date, { fallback: todayLocal() });

    await withPortfolioLock(pid, async q => {
      await addTransaction(q, pid, { symbol: cashSymbol(currency), account, side: 'deposit', shares: amount, price: 1, currency, trade_date });
      return rederiveAndCheck(q, pid);
    });
    res.status(201).json({ symbol: cashSymbol(currency), currency, account, amount });
  } catch (e) { next(e); }
});

/**
 * Adjust a holding's quantity and/or its average cost. Body: { shares?, cost_price? }.
 *
 * `shares` records the matching trade (buy/sell for securities, deposit/withdraw for cash)
 * to reach the target, priced at the latest close. `cost_price` rescales the lot's
 * existing buys so the derived average matches — see setLotAverageCost. Both are ledger
 * writes, so they survive a re-derive, and both commit or roll back together.
 */
portfoliosRouter.patch('/:id/holdings/:holdingId', async (req, res, next) => {
  try {
    const pid = parseId(req.params.id, 'Portfolio');
    const holdingId = parseId(req.params.holdingId, 'Holding');
    const wantsShares = provided(req.body?.shares);
    const wantsCost = provided(req.body?.cost_price);
    if (!wantsShares && !wantsCost) throw badRequest('Nothing to update (shares or cost_price).');
    const target = wantsShares ? parseShares(req.body.shares, 'shares', { allowZero: true }) : null;
    const cost = wantsCost ? parsePrice(req.body.cost_price, 'cost_price') : null;

    const result = await withPortfolioLock(pid, async q => {
      const [row] = await q(
        `SELECT symbol, account, shares, currency, cost_price FROM portfolio_holdings WHERE id = ? AND portfolio_id = ?`,
        [holdingId, pid]
      );
      if (!row) throw new HttpError(404, 'Holding not found');
      const cash = isCash(row.symbol);

      // Cost-only edit: rescale the lot's buys, then re-derive.
      if (!wantsShares) {
        if (cash) throw badRequest('Cash is always valued 1:1 — it has no cost basis to edit.');
        const n = await setLotAverageCost(q, pid, row.symbol, row.account, cost);
        if (n === 0) throw badRequest('No purchases on record for this lot, so there is no cost basis to rescale.');
        const warnings = await rederiveAndCheck(q, pid);
        return { updated: 1, cost_price: cost, repriced_buys: n, warnings };
      }

      let warnings = [];
      const delta = target - Number(row.shares);
      // Anything under half the column's precision would store as a 0-share trade.
      if (Math.abs(delta) >= MIN_SHARES / 2) {
        const trade_date = todayLocal();
        if (cash) {
          await addTransaction(q, pid, { symbol: row.symbol, account: row.account, side: delta > 0 ? 'deposit' : 'withdraw', shares: Math.abs(delta), price: 1, currency: row.currency, trade_date });
        } else {
          const price = await marketPriceFor(row, q);
          await addTransaction(q, pid, { symbol: row.symbol, account: row.account, side: delta > 0 ? 'buy' : 'sell', shares: Math.abs(delta), price, currency: row.currency, trade_date });
        }
        warnings = await rederiveAndCheck(q, pid);
      }

      // A cost_price sent alongside shares is applied after the trade, so the average lands
      // on the target across the new share count too.
      if (wantsCost && !cash) {
        const n = await setLotAverageCost(q, pid, row.symbol, row.account, cost);
        if (n > 0) {
          warnings = await rederiveAndCheck(q, pid);
          return { updated: 1, cost_price: cost, repriced_buys: n, warnings };
        }
      }
      return { updated: 1, warnings };
    });
    res.json(result);
  } catch (e) { next(e); }
});

/** Remove a holding = record a full SELL (or WITHDRAW for cash) in the ledger, at the latest close. */
portfoliosRouter.delete('/:id/holdings/:holdingId', async (req, res, next) => {
  try {
    const pid = parseId(req.params.id, 'Portfolio');
    const holdingId = parseId(req.params.holdingId, 'Holding');
    const warnings = await withPortfolioLock(pid, async q => {
      const [row] = await q(
        `SELECT symbol, account, shares, currency, cost_price FROM portfolio_holdings WHERE id = ? AND portfolio_id = ?`,
        [holdingId, pid]
      );
      if (!row) throw new HttpError(404, 'Holding not found');
      const trade_date = todayLocal();
      if (isCash(row.symbol)) {
        await addTransaction(q, pid, { symbol: row.symbol, account: row.account, side: 'withdraw', shares: Number(row.shares), price: 1, currency: row.currency, trade_date });
      } else {
        const price = await marketPriceFor(row, q);
        await addTransaction(q, pid, { symbol: row.symbol, account: row.account, side: 'sell', shares: Number(row.shares), price, currency: row.currency, trade_date });
      }
      return rederiveAndCheck(q, pid);
    });
    res.json({ deleted: 1, warnings });
  } catch (e) { next(e); }
});

/** List a portfolio's transactions (newest first). */
portfoliosRouter.get('/:id/transactions', async (req, res, next) => {
  try {
    const pid = parseId(req.params.id, 'Portfolio');
    const rows = await query(
      `SELECT id, symbol, account, side, shares, price, currency,
              DATE_FORMAT(trade_date, '%Y-%m-%d') AS trade_date
         FROM transactions WHERE portfolio_id = ? ORDER BY trade_date DESC, id DESC`,
      [pid]
    );
    res.json({ count: rows.length, transactions: rows });
  } catch (e) { next(e); }
});

/**
 * Record a transaction. Body: { side:'buy'|'sell'|'deposit'|'withdraw', symbol?, account?,
 * shares, price?, currency?, trade_date? }. Securities auto-track; no lot may go short at
 * any point in its history. Cash moves only via deposit/withdraw and may go negative
 * (returned as a warning).
 */
portfoliosRouter.post('/:id/transactions', async (req, res, next) => {
  try {
    const pid = parseId(req.params.id, 'Portfolio');
    const side = String(req.body?.side || '');
    if (!['buy', 'sell', 'deposit', 'withdraw'].includes(side)) throw badRequest('side must be buy, sell, deposit, or withdraw');
    const isCashTx = side === 'deposit' || side === 'withdraw';
    const shares = parseShares(req.body?.shares, isCashTx ? 'amount' : 'shares');
    const account = parseAccount(req.body?.account);
    const trade_date = parseTradeDate(req.body?.trade_date, { fallback: todayLocal() });

    let symbol, currency, price;
    if (isCashTx) {
      currency = String(req.body?.currency || '').toUpperCase();
      if (!CASH_CURRENCIES.includes(currency)) throw badRequest(`currency must be one of ${CASH_CURRENCIES.join(', ')}`);
      symbol = cashSymbol(currency); price = 1;
    } else {
      const priceInput = provided(req.body?.price) ? parsePrice(req.body.price) : null;
      await assertPortfolioExists(pid);
      const inst = (await ensureTrackedInstrument(req.body?.symbol)).instrument;
      symbol = inst.symbol; currency = inst.currency;
      price = priceInput ?? (await latestClose(symbol));
      if (price == null) throw badRequest('price is required (no latest close available)');
    }

    const { txId, warnings } = await withPortfolioLock(pid, async q => {
      const txId = await addTransaction(q, pid, { symbol, account, side, shares, price, currency, trade_date });
      return { txId, warnings: await rederiveAndCheck(q, pid) };
    });
    res.status(201).json({ id: txId, side, symbol, account, shares, price, currency, trade_date, warnings });
  } catch (e) { next(e); }
});

/**
 * Edit a transaction's price, shares/amount, and/or trade_date, then re-derive holdings/
 * chart/cash (this is how the average cost basis gets adjusted). Cash rows keep price = 1.
 * If the edit would leave any lot short at any point in its history — including by moving
 * a sell ahead of the buy that funds it — it is rolled back.
 */
portfoliosRouter.patch('/:id/transactions/:txId', async (req, res, next) => {
  try {
    const pid = parseId(req.params.id, 'Portfolio');
    const txId = parseId(req.params.txId, 'Transaction');

    const fields = {};
    if (provided(req.body?.shares)) fields.shares = parseShares(req.body.shares, 'shares/amount');
    if (provided(req.body?.trade_date)) fields.trade_date = parseTradeDate(req.body.trade_date);
    if (provided(req.body?.price)) fields.price = parsePrice(req.body.price);
    const keys = Object.keys(fields);
    if (keys.length === 0) throw badRequest('Nothing to update (price, shares, or trade_date).');

    const warnings = await withPortfolioLock(pid, async q => {
      const [row] = await q(`SELECT side FROM transactions WHERE id = ? AND portfolio_id = ?`, [txId, pid]);
      if (!row) throw new HttpError(404, 'Transaction not found');
      if (fields.price != null && (row.side === 'deposit' || row.side === 'withdraw')) {
        throw badRequest('Cash transactions have no price (always 1).');
      }
      // Column names come from the fixed `fields` keys above, never from the request.
      await q(
        `UPDATE transactions SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND portfolio_id = ?`,
        [...keys.map(k => fields[k]), txId, pid]
      );
      return rederiveAndCheck(q, pid);
    });
    res.json({ id: txId, ...fields, warnings });
  } catch (e) { next(e); }
});

/**
 * Delete a transaction and re-derive holdings/chart/cash. Refused (rolled back) when the
 * ledger without it would leave a lot short — e.g. deleting the buy an existing sell drew on.
 */
portfoliosRouter.delete('/:id/transactions/:txId', async (req, res, next) => {
  try {
    const pid = parseId(req.params.id, 'Portfolio');
    const txId = parseId(req.params.txId, 'Transaction');
    const warnings = await withPortfolioLock(pid, async q => {
      const r = await q(`DELETE FROM transactions WHERE id = ? AND portfolio_id = ?`, [txId, pid]);
      if (r.affectedRows === 0) throw new HttpError(404, 'Transaction not found');
      return rederiveAndCheck(q, pid);
    });
    res.json({ deleted: 1, warnings });
  } catch (e) { next(e); }
});
