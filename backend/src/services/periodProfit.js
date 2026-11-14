/**
 * Actual profit on a portfolio's securities over a period (year-to-date by default): what
 * the money really made, as opposed to the YTD card's "today's holdings since Jan 1".
 *
 *   profit = value now − value at the start − money put in (buys − sells) + dividends
 *
 * Each piece is valued as it happened:
 *   - start: the holdings on the day before the period, at that day's close and FX rate;
 *   - buys and sells: at their recorded price, converted at the trade date's FX rate — unless
 *     that price is outside the day's low–high range (see tradePrice): then it is an average
 *     cost typed on the Holdings card, not a price paid that day, and the day's close is used;
 *   - dividends: shares held before each ex-date × the per-share amount, converted at the
 *     ex-date's rate, after withholding tax (see dividendTaxRate);
 *   - now: today's holdings at the latest close and the current FX rate.
 * So the exchange rate's move counts, a purchase only earns from its own date, and income
 * is included. Cash is left out, as on the other return cards (it earns nothing here).
 *
 * The percentage is profit over the money that was at work: the start value plus every
 * purchase. A time-weighted figure (Modified Dietz) was tried and dropped: a late purchase
 * counts for only part of the period, so one June buy down 39% read as −75%.
 */
import { query } from '../db.js';

const DAY_MS = 86_400_000;
const isCash = sym => typeof sym === 'string' && sym.startsWith('CASH:');

/**
 * Accounts where an employer's stock plan delivers shares (RSU vests, ESPP): buys there are
 * stock pay, not money put in. Matched on the account name the user typed.
 */
const STOCK_PLAN = /morgan\s*stanley|e\*?\s*trade|shareworks|stock\s*plan|equity\s*award|equatex|computershare|\brsu\b|\bespp\b/i;
export const isStockPayAccount = account => STOCK_PLAN.test(String(account || ''));

/**
 * Withholding on a cash dividend, for a Korean resident: none in Korea's tax-deferred
 * accounts (IRP, ISA, pension savings 연금저축), 15.4% on Korean dividends, and the US
 * treaty rate of 15% on foreign ones.
 */
export function dividendTaxRate(currency, account = '') {
  if (/IRP|ISA|연금/i.test(account)) return 0;
  return currency === 'KRW' ? 0.154 : 0.15;
}

/** Last point on or before `date` from an ascending [{ d, v, … }] series, or null. */
export function barAsOf(series, date) {
  if (!series || series.length === 0 || series[0].d > date) return null;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid].d <= date) lo = mid; else hi = mid - 1;
  }
  return series[lo];
}

/** Last value on or before `date` from an ascending [{ d, v }] series, or null. */
export function asOf(series, date) {
  return barAsOf(series, date)?.v ?? null;
}

// Rounding allowance around a day's low–high range: a price this close to it still counts
// as traded that day.
const RANGE_TOLERANCE = 0.005;
// With no low–high for the day, a price this far from the close counts as not traded then.
const CLOSE_TOLERANCE = 0.05;

/**
 * The price a trade is counted at for a period's profit, and why:
 *   { price, status: 'ok' }           the recorded price could have been paid that day
 *   { price: close, status: 'average' } it is outside the day's low–high range (or, with no
 *        range, more than 5% from the close): an average cost entered on the Holdings card,
 *        so the day's close stands in for what the shares were worth when they came in
 *   { price, status: 'no_price' }     no close on or before that day: the recorded price
 * The day is the last trading day on or before the trade date (a weekend entry → Friday).
 * Cost basis, Total Gain and Inception keep the recorded price; this is for periods only.
 */
export function tradePrice(t, bars) {
  const price = Number(t.price);
  const bar = barAsOf(bars?.get(t.symbol), t.trade_date);
  if (!bar || !(bar.v > 0)) return { price, status: 'no_price', bar: null };
  const lo = Number(bar.lo), hi = Number(bar.hi);
  const inside = lo > 0 && hi >= lo
    ? price >= lo * (1 - RANGE_TOLERANCE) && price <= hi * (1 + RANGE_TOLERANCE)
    : Math.abs(price / bar.v - 1) <= CLOSE_TOLERANCE;
  return inside ? { price, status: 'ok', bar } : { price: bar.v, status: 'average', bar };
}

const dayBefore = d => new Date(Date.parse(`${d}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
const dayAfter = d => new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/**
 * Pure calculation. Inputs:
 *   txns       ledger rows {symbol, account, side, shares, price, currency, trade_date}, ascending
 *   start, end 'YYYY-MM-DD' (inclusive)
 *   closes     Map symbol → [{d, v}] daily closes in the instrument currency
 *   dividends  Map symbol → [{d, v}] per-share dividends by ex-date
 *   latest     Map symbol → latest close
 *   toBase(amount, currency, date | null)  converts at that date's rate, or today's for null
 * Returns the pieces in the base currency, plus the symbols that had no price to value.
 */
export function periodProfit({ txns, start, end, closes, dividends, latest, toBase, taxRate = dividendTaxRate }) {
  const trades = txns.filter(t => !isCash(t.symbol) && (t.side === 'buy' || t.side === 'sell'));
  const signed = t => (t.side === 'buy' ? 1 : -1) * Number(t.shares);
  const before = dayBefore(start);
  const missing = new Set();

  // Shares per symbol|account held strictly before a date.
  const heldBefore = date => {
    const m = new Map();
    for (const t of trades) {
      if (t.trade_date >= date) break;
      const k = `${t.symbol}|${t.account || ''}`;
      const cur = m.get(k) || { symbol: t.symbol, account: t.account || '', currency: t.currency, shares: 0 };
      cur.shares += signed(t);
      m.set(k, cur);
    }
    return [...m.values()].filter(h => Math.abs(h.shares) > 1e-9);
  };

  let startValue = 0;
  for (const h of heldBefore(start)) {
    const px = asOf(closes.get(h.symbol), before);
    if (px == null) { missing.add(h.symbol); continue; }
    startValue += toBase(h.shares * px, h.currency, before);
  }

  let bought = 0, sold = 0;
  for (const t of trades) {
    if (t.trade_date < start || t.trade_date > end) continue;
    const amount = toBase(Number(t.shares) * tradePrice(t, closes).price, t.currency, t.trade_date);
    if (t.side === 'buy') bought += amount; else sold += amount;
  }

  let dividendIncome = 0;
  const symbols = new Set(trades.map(t => t.symbol));
  for (const sym of symbols) {
    for (const { d, v } of dividends.get(sym) || []) {
      if (d < start || d > end) continue;
      for (const h of heldBefore(d)) {
        if (h.symbol !== sym || h.shares <= 0) continue;
        dividendIncome += toBase(h.shares * v, h.currency, d) * (1 - taxRate(h.currency, h.account));
      }
    }
  }

  // The holdings at the period's end: trades after it (a past year's review) don't count.
  let endValue = 0;
  for (const h of heldBefore(dayAfter(end))) {
    const px = latest.get(h.symbol);
    if (px == null) { missing.add(h.symbol); continue; }
    endValue += toBase(h.shares * px, h.currency, null);
  }

  const netFlows = bought - sold;
  const profit = endValue - startValue - netFlows + dividendIncome;
  const invested = startValue + bought;
  return {
    start, end,
    start_value: startValue,
    bought, sold,
    dividends: dividendIncome,
    end_value: endValue,
    price_and_fx: endValue - startValue - netFlows,
    profit,
    invested,
    return: invested > 0 ? profit / invested : null,
    missing: [...missing].sort(),
  };
}

/**
 * Trades in the period not counted at their recorded price (tradePrice): those entered at
 * an average cost, outside the day's range, and those with no price that day. For each:
 * the account, shares, recorded price and amount, the day's range and close, and the
 * price it is counted at. [{ trade_date, account, symbol, side, shares, price, currency,
 * status, low, high, close, counted_at, diff }]
 */
export function priceChecks(txns, start, end, closes) {
  const out = [];
  for (const t of txns) {
    if (isCash(t.symbol) || (t.side !== 'buy' && t.side !== 'sell')) continue;
    if (t.trade_date < start || t.trade_date > end) continue;
    const r = tradePrice(t, closes);
    if (r.status === 'ok') continue;
    const price = Number(t.price);
    const close = r.bar ? r.bar.v : null;
    out.push({
      trade_date: t.trade_date, account: t.account || '', symbol: t.symbol, side: t.side,
      shares: Number(t.shares), price, currency: t.currency, status: r.status,
      low: r.bar?.lo != null ? Number(r.bar.lo) : null, high: r.bar?.hi != null ? Number(r.bar.hi) : null,
      close, counted_at: r.price, diff: close ? price / close - 1 : null,
    });
  }
  return out;
}

/** Cash deposited and withdrawn in the period, converted at each date's rate. */
export function cashFlows(txns, start, end, toBase) {
  let deposits = 0, withdrawals = 0;
  for (const t of txns) {
    if (!isCash(t.symbol) || t.trade_date < start || t.trade_date > end) continue;
    const ccy = t.currency || t.symbol.slice(5);
    const amount = toBase(Number(t.shares) * (Number(t.price) || 1), ccy, t.trade_date);
    if (t.side === 'deposit') deposits += amount; else if (t.side === 'withdraw') withdrawals += amount;
  }
  return { deposits, withdrawals };
}

/**
 * Cash held at the end of a day: every deposit less every withdrawal up to and including it,
 * per currency, converted at the period end's rate (toBase with a null date).
 */
export function cashBalance(txns, end, toBase) {
  const held = new Map();
  for (const t of txns) {
    if (!isCash(t.symbol) || t.trade_date > end) continue;
    const ccy = t.currency || t.symbol.slice(5);
    const amount = Number(t.shares) * (Number(t.price) || 1);
    const sign = t.side === 'deposit' ? 1 : t.side === 'withdraw' ? -1 : 0;
    held.set(ccy, (held.get(ccy) || 0) + sign * amount);
  }
  let total = 0;
  for (const [ccy, amount] of held) total += toBase(amount, ccy, null);
  return total;
}

/** A dated series per symbol from rows of { symbol, d, v } (+ the day's lo / hi when given). */
function seriesBySymbol(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.symbol)) m.set(r.symbol, []);
    const point = { d: r.d, v: Number(r.v) };
    if (r.lo != null) point.lo = Number(r.lo);
    if (r.hi != null) point.hi = Number(r.hi);
    m.get(r.symbol).push(point);
  }
  return m;
}

/**
 * One calendar year of a portfolio's securities — the current year to date by default — in
 * each of `currencies`, with what the year-end review shows beside the profit:
 *   year, years      the year shown, and every year from the first trade to now
 *   currencies[ccy]  the profit (periodProfit) + by_symbol (each holding's share of it),
 *                    fixed_fx (the same year with every rate held at the prior Dec 31's) and
 *                    cash (deposits and withdrawals in the year)
 *   checks           trades whose recorded price is far from that day's close (priceChecks)
 *   fx               KRW per USD at the start and the end of the year
 * The current year ends today, valued at the latest close and `rates` (today's
 * { krwPerUsd, krwPerJpy }, as the holdings are); a past year ends on its Dec 31, valued at
 * that day's closes and rates. Returns null for a portfolio with no trades.
 */
export async function yearReview(portfolioId, currencies, rates, { year, today = new Date() } = {}) {
  const thisYear = today.getFullYear();
  year = Number(year) || thisYear;
  const current = year >= thisYear;
  const start = `${year}-01-01`;
  const end = current
    ? `${year}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    : `${year}-12-31`;
  const from = `${year - 1}-12-01`; // enough history to find the last close before Jan 1

  const txns = await query(
    `SELECT symbol, account, side, shares, price, currency, DATE_FORMAT(trade_date,'%Y-%m-%d') AS trade_date
       FROM transactions WHERE portfolio_id = ? ORDER BY trade_date ASC, id ASC`,
    [portfolioId]
  );
  const symbols = [...new Set(txns.filter(t => !isCash(t.symbol)).map(t => t.symbol))];
  if (symbols.length === 0) return null;
  const before = dayBefore(start);
  const openingUntil = new Date(Date.parse(`${txns[0].trade_date}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const firstYear = Number(txns[0].trade_date.slice(0, 4));
  const years = [];
  for (let y = thisYear; y >= firstYear; y--) years.push(y);

  // query() runs prepared statements, which don't expand an array parameter: one ? per symbol.
  const list = symbols.map(() => '?').join(', ');
  const [priceRows, divRows, fxRows, latestRows, nameRows] = await Promise.all([
    query(
      `SELECT i.symbol, DATE_FORMAT(p.trade_date,'%Y-%m-%d') AS d, p.close_px AS v, p.low_px AS lo, p.high_px AS hi
         FROM prices p JOIN instruments i ON i.id = p.instrument_id
        WHERE i.symbol IN (${list}) AND p.trade_date BETWEEN ? AND ? ORDER BY p.trade_date`,
      [...symbols, from, end]
    ),
    query(
      `SELECT i.symbol, DATE_FORMAT(d.ex_date,'%Y-%m-%d') AS d, d.amount AS v
         FROM dividends d JOIN instruments i ON i.id = d.instrument_id
        WHERE i.symbol IN (${list}) AND d.ex_date >= ? ORDER BY d.ex_date`,
      [...symbols, start]
    ),
    query(
      `SELECT i.symbol, DATE_FORMAT(p.trade_date,'%Y-%m-%d') AS d, p.close_px AS v
         FROM prices p JOIN instruments i ON i.id = p.instrument_id
        WHERE i.symbol IN ('KRW=X', 'JPYKRW=X') AND p.trade_date BETWEEN ? AND ? ORDER BY p.trade_date`,
      [from, end]
    ),
    query(
      `SELECT i.symbol, lp.close_px AS v FROM instruments i
         JOIN v_latest_prices lp ON lp.instrument_id = i.id WHERE i.symbol IN (${list})`,
      symbols
    ),
    query(`SELECT symbol, display_name FROM instruments WHERE symbol IN (${list})`, symbols),
  ]);
  const names = new Map(nameRows.map(r => [r.symbol, r.display_name]));
  const closes = seriesBySymbol(priceRows);
  const dividends = seriesBySymbol(divRows);
  const fx = seriesBySymbol(fxRows);
  // The year's closing prices: the latest for the current year, each Dec 31's for a past one.
  const latest = current
    ? new Map(latestRows.map(r => [r.symbol, Number(r.v)]))
    : new Map(symbols.map(s => [s, asOf(closes.get(s), end)]).filter(([, v]) => v != null));

  // KRW per unit of a currency on a date. A null date is the year's end: today's live rate
  // for the current year, the Dec 31 close for a past one.
  const krwPer = (ccy, date) => {
    if (ccy === 'KRW') return 1;
    if (date == null && !current) date = end;
    if (date == null) return ccy === 'USD' ? rates.krwPerUsd : ccy === 'JPY' ? rates.krwPerJpy : null;
    return asOf(fx.get(ccy === 'USD' ? 'KRW=X' : ccy === 'JPY' ? 'JPYKRW=X' : ''), date)
      ?? (ccy === 'USD' ? rates.krwPerUsd : ccy === 'JPY' ? rates.krwPerJpy : null);
  };

  const converter = rateOn => (base) => (amount, ccy, date) => {
    const a = rateOn(ccy, date), b = rateOn(base, date);
    return a && b ? (amount * a) / b : amount; // unsupported currency: at face, as elsewhere
  };
  const actual = converter(krwPer);
  // Every conversion at Dec 31's rate: the year as it would have gone had rates not moved.
  const fixed = converter(ccy => krwPer(ccy, before));
  const run = (toBase, rows = txns) => periodProfit({ txns: rows, start, end, closes, dividends, latest, toBase });

  const out = {};
  for (const base of currencies) {
    const toBase = actual(base);
    const whole = run(toBase);
    // Each holding's profit, and the part of it its investment earned with rates held at the
    // start (`investment`); the rest (`fx`) is the exchange rate's doing.
    const bySymbol = symbols.map(symbol => {
      const rows = txns.filter(t => t.symbol === symbol);
      const r = run(toBase, rows);
      const k = run(fixed(base), rows);
      const currency = rows[0]?.currency;
      return {
        symbol, name: names.get(symbol) || symbol, currency,
        profit: r.profit, dividends: r.dividends, invested: r.invested,
        start_value: r.start_value, bought: r.bought, end_value: r.end_value,
        investment: k.profit, investment_dividends: k.dividends, fx: r.profit - k.profit,
      };
    }).filter(r => r.invested > 0 || r.end_value > 0).sort((a, b) => b.investment - a.investment);
    const f = run(fixed(base));
    // Shares delivered by a stock plan this year, at the value they arrived with.
    const pay = run(toBase, txns.filter(t => !isCash(t.symbol) && isStockPayAccount(t.account)));
    // Holdings entered as the records began (the first week): owned before, not bought now.
    const opening = run(toBase, txns.filter(t => !isCash(t.symbol) && !isStockPayAccount(t.account) && t.trade_date <= openingUntil));
    out[base] = {
      ...whole,
      by_symbol: bySymbol,
      // The year with every rate held at the prior Dec 31's: what the investments earned in
      // their own markets (price change + dividends). profit − this = the exchange-rate effect.
      fixed_fx: { profit: f.profit, return: f.return, price: f.price_and_fx, dividends: f.dividends },
      fx_effect: whole.profit - f.profit,
      cash: cashFlows(txns, start, end, toBase),
      cash_balance: cashBalance(txns, end, toBase),
      stock_pay: Math.max(0, pay.bought - pay.sold),
      opening: Math.max(0, opening.bought - opening.sold),
    };
  }
  return {
    year, years, current,
    currencies: out,
    checks: priceChecks(txns, start, end, closes),
    fx: { usd_start: krwPer('USD', before), usd_end: krwPer('USD', null) },
  };
}

/**
 * Every year of a portfolio side by side, for the review's year-by-year chart: each year's
 * assets at its end (securities + cash, the current year's as of today) and its profit,
 * split into investment profit and the exchange-rate effect. Oldest year first.
 */
export async function yearHistory(portfolioId, currencies, rates, { today = new Date() } = {}) {
  const first = await yearReview(portfolioId, currencies, rates, { today });
  if (!first) return null;
  const reviews = await Promise.all(first.years.map(y =>
    (y === first.year ? first : yearReview(portfolioId, currencies, rates, { year: y, today }))));
  const years = reviews.map(r => ({
    year: r.year,
    current: r.current,
    ...Object.fromEntries(currencies.map(c => {
      const x = r.currencies[c];
      return [c, {
        end: x.end,
        securities: x.end_value,
        cash: x.cash_balance,
        assets: x.end_value + x.cash_balance,
        profit: x.profit,
        return: x.return,
        investment: x.fixed_fx.profit,
        investment_return: x.fixed_fx.return,
        fx_effect: x.fx_effect,
        // What funding() on the review page needs to split the year's purchases by source.
        bought: x.bought,
        sold: x.sold,
        dividends: x.dividends,
        cash_flows: x.cash,
        stock_pay: x.stock_pay,
        opening: x.opening,
      }];
    })),
  })).sort((a, b) => a.year - b.year);
  return { currencies, years };
}
