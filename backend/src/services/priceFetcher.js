/**
 * Pull historical OHLCV from Yahoo Finance and upsert into prices table.
 * Uses yahoo-finance2.
 */
import YahooFinance from 'yahoo-finance2';
import { query } from '../db.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// Spacing between Yahoo calls + retry policy for 429 throttling.
const YF_CALL_DELAY_MS = Number(process.env.YF_CALL_DELAY_MS || 1200);
const YF_MAX_RETRIES = Number(process.env.YF_MAX_RETRIES || 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRateLimit(err) {
  const msg = String(err?.message || '');
  return msg.includes('Too Many Requests') || msg.includes('429');
}

async function chartWithRetry(symbol, opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      // validateResult:false — tolerate Yahoo payloads that don't match the lib's strict schema.
      return await yahooFinance.chart(symbol, opts, { validateResult: false });
    } catch (err) {
      if (!isRateLimit(err) || attempt >= YF_MAX_RETRIES) throw err;
      const backoff = YF_CALL_DELAY_MS * Math.pow(2, attempt + 1);
      console.warn(`[priceFetcher] ${symbol} 429, backing off ${backoff}ms (retry ${attempt + 1}/${YF_MAX_RETRIES})`);
      await sleep(backoff);
    }
  }
}

/**
 * Look up a symbol on Yahoo to validate it exists and grab its name/currency.
 * Returns null if Yahoo has no usable quote for the symbol.
 */
export async function fetchQuoteMeta(symbol) {
  await sleep(YF_CALL_DELAY_MS);
  try {
    // validateResult:false — tolerate Yahoo quote payloads that don't match the lib's strict schema.
    const q = await yahooFinance.quote(symbol, {}, { validateResult: false });
    if (!q || (q.regularMarketPrice == null && q.shortName == null && q.longName == null)) return null;
    return {
      symbol: q.symbol || symbol,
      name: q.longName || q.shortName || symbol,
      currency: q.currency || null,
      price: q.regularMarketPrice ?? null,
      quote_type: q.quoteType || null,
      exchange: q.fullExchangeName || q.exchange || null,
    };
  } catch {
    return null;
  }
}

/**
 * Search Yahoo for tickers by name or symbol (e.g. "apple" or "AAPL").
 * Returns a short list of equity/ETF/fund/index matches for a picker.
 * `opts` is merged into Yahoo's query options — pass { region, lang } to bias
 * the search toward a market (e.g. region:'KR', lang:'ko-KR' for Korean listings).
 */
export async function searchSymbols(q, count = 8, opts = {}) {
  try {
    // validateResult:false — Yahoo's search payload doesn't match the lib's strict schema (e.g. typeDisp casing).
    const r = await yahooFinance.search(q, { quotesCount: count, newsCount: 0, ...opts }, { validateResult: false });
    return (r?.quotes || [])
      .filter(x => x.symbol && ['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX'].includes(x.quoteType))
      .map(x => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        exchange: x.exchDisp || x.exchange || '',
        type: x.quoteType,
      }));
  } catch {
    return [];
  }
}

/**
 * Batch live quotes for many symbols in one Yahoo call. Returns a map
 * symbol -> { price, currency, time, market_state, previous_close, change, change_percent }.
 * `market_state` is Yahoo's session state ('REGULAR' when the market is open; 'PRE',
 * 'POST', 'CLOSED', etc. otherwise). When the market is closed, `price` is the last
 * close. Used by the audit and the overview's live cards.
 */
export async function fetchQuotes(symbols) {
  if (!symbols || symbols.length === 0) return {};
  try {
    const res = await yahooFinance.quote(symbols, {}, { validateResult: false });
    const arr = Array.isArray(res) ? res : [res];
    const out = {};
    for (const q of arr) {
      if (!q?.symbol) continue;
      const price = q.regularMarketPrice ?? null;
      const prev = q.regularMarketPreviousClose ?? null;
      out[q.symbol] = {
        price,
        currency: q.currency ?? null,
        time: q.regularMarketTime ?? null,
        market_state: q.marketState ?? null,
        previous_close: prev,
        change: q.regularMarketChange ?? (price != null && prev != null ? price - prev : null),
        change_percent: q.regularMarketChangePercent ?? null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

// en-CA formats as YYYY-MM-DD. Formatters are cached per timezone — building one is slow.
const dateFormatters = new Map();
function formatterFor(timeZone) {
  if (!dateFormatters.has(timeZone)) {
    dateFormatters.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  return dateFormatters.get(timeZone);
}

/**
 * Turn Yahoo daily quotes into one row per trading date.
 *
 * A bar's timestamp is its session start, and the session's date must be read in the
 * EXCHANGE's timezone, not UTC. Most listings are unaffected (a New York bar opens 13:30
 * UTC, a Seoul bar 00:00 UTC), but Yahoo's FX pairs (KRW=X, JPYKRW=X) are pinned to
 * London midnight — 23:00 UTC the previous day during British Summer Time — so a UTC
 * reading filed every summer bar one day early, including onto Sundays.
 *
 * Bars without a close are dropped. If two bars land on the same date (a finished session
 * plus Yahoo's in-progress one), the later wins.
 */
export function quotesToBars(quotes, timeZone) {
  let fmt;
  try { fmt = formatterFor(timeZone || 'UTC'); } catch { fmt = formatterFor('UTC'); } // unknown tz name
  const byDate = new Map();
  for (const q of quotes || []) {
    if (!q || q.close == null || q.date == null) continue;
    const d = new Date(q.date);
    if (Number.isNaN(d.getTime())) continue;
    byDate.set(fmt.format(d), q);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([trade_date, q]) => ({
      trade_date,
      open_px: q.open ?? null, high_px: q.high ?? null, low_px: q.low ?? null,
      close_px: q.close, volume: q.volume ?? null,
      // Split- and dividend-adjusted close. Not stored in `prices`; the historical replay
      // uses it so a holding's return over a past event includes what it paid out.
      adj_close: q.adjclose ?? null,
    }));
}

/** Fetch `days` of daily bars for a symbol from Yahoo, dated in the exchange's timezone. Stores nothing. */
export async function fetchDailyBars(symbol, days = 365) {
  const period2 = new Date();
  const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await sleep(YF_CALL_DELAY_MS);
  const result = await chartWithRetry(symbol, { period1, period2, interval: '1d' });
  return {
    timeZone: result?.meta?.exchangeTimezoneName || 'UTC',
    bars: quotesToBars(result?.quotes, result?.meta?.exchangeTimezoneName),
  };
}

/** Upsert bars for one instrument. `q` is a query executor (the pool's, or a transaction's). */
export async function storeBars(q, instrumentId, bars) {
  let written = 0;
  for (const b of bars) {
    const r = await q(
      `INSERT INTO prices (instrument_id, trade_date, open_px, high_px, low_px, close_px, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         open_px=VALUES(open_px), high_px=VALUES(high_px),
         low_px=VALUES(low_px), close_px=VALUES(close_px), volume=VALUES(volume)`,
      [instrumentId, b.trade_date, b.open_px, b.high_px, b.low_px, b.close_px, b.volume]
    );
    if (r.affectedRows > 0) written++;
  }
  return written;
}

/**
 * @param {{id:number, symbol:string}} instrument
 * @param {number} days  How many days back to fetch
 */
export async function fetchAndStorePrices(instrument, days = 365) {
  const { bars } = await fetchDailyBars(instrument.symbol, days);
  if (bars.length === 0) {
    return { symbol: instrument.symbol, inserted: 0, note: 'No quotes returned' };
  }
  const inserted = await storeBars(query, instrument.id, bars);
  return {
    symbol: instrument.symbol,
    fetched: bars.length,
    inserted_or_updated: inserted,
    latest: bars[bars.length - 1].close_px,
  };
}
