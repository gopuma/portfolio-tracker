/**
 * Pull historical OHLCV from Yahoo Finance and upsert into prices table.
 * Uses yahoo-finance2.
 */
import YahooFinance from 'yahoo-finance2';
import { pool } from '../db.js';

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

/**
 * @param {{id:number, symbol:string}} instrument
 * @param {number} days  How many days back to fetch
 */
export async function fetchAndStorePrices(instrument, days = 365) {
  const period2 = new Date();
  const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  await sleep(YF_CALL_DELAY_MS);
  const result = await chartWithRetry(instrument.symbol, {
    period1, period2,
    interval: '1d',
  });

  const quotes = (result?.quotes || []).filter(q => q && q.close != null);
  if (quotes.length === 0) {
    return { symbol: instrument.symbol, inserted: 0, note: 'No quotes returned' };
  }

  const conn = await pool.getConnection();
  let inserted = 0;
  try {
    for (const q of quotes) {
      const d = new Date(q.date);
      const trade_date = d.toISOString().slice(0, 10);
      const [r] = await conn.execute(
        `INSERT INTO prices (instrument_id, trade_date, open_px, high_px, low_px, close_px, volume)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           open_px=VALUES(open_px), high_px=VALUES(high_px),
           low_px=VALUES(low_px), close_px=VALUES(close_px), volume=VALUES(volume)`,
        [instrument.id, trade_date, q.open ?? null, q.high ?? null, q.low ?? null, q.close, q.volume ?? null]
      );
      if (r.affectedRows > 0) inserted++;
    }
  } finally {
    conn.release();
  }
  return {
    symbol: instrument.symbol,
    fetched: quotes.length,
    inserted_or_updated: inserted,
    latest: quotes[quotes.length - 1].close,
  };
}
