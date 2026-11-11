/**
 * Bitcoin in won from Upbit, stored as UPBIT-KRW-BTC.
 * Yahoo's BTC-USD is the global price; Korean exchanges trade at their own won price,
 * usually a little above it (the "kimchi premium"), so won holdings are valued here.
 *
 * Daily history: https://api.upbit.com/v1/candles/days?market=KRW-BTC&count=200&to=<UTC>
 * (public, no key; newest first, at most 200 candles per call, back to Sept 2017).
 * Each daily candle runs 09:00–09:00 KST, i.e. one UTC day, the same day boundary as
 * Yahoo's BTC-USD, so the two series line up date for date. Today's candle is still
 * open: its close is the latest trade, and later refreshes overwrite it.
 */
import { pool } from '../db.js';

const UPBIT_URL = 'https://api.upbit.com/v1';
// Tracked symbol → Upbit market code.
export const UPBIT_MARKETS = { 'UPBIT-KRW-BTC': 'KRW-BTC' };
const PAGE_SIZE = 200;
// Upbit allows about 10 candle requests a second; stay well under it.
const PAGE_DELAY_MS = 150;
const MAX_PAGES = 30; // 6000 days, more than Upbit's history
const FETCH_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Upbit HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Daily candles → price rows ({trade_date, open_px, high_px, low_px, close_px}), skipping bad ones. */
export function parseCandles(candles) {
  return (candles || [])
    .map(c => ({
      trade_date: String(c.candle_date_time_utc || '').slice(0, 10),
      open_px: Number(c.opening_price),
      high_px: Number(c.high_price),
      low_px: Number(c.low_price),
      close_px: Number(c.trade_price),
    }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.trade_date) && Number.isFinite(r.close_px) && r.close_px > 0);
}

/** Latest Upbit trade for a market: price, today's change (since 09:00 KST) and its time. */
export async function fetchLiveUpbit(market = 'KRW-BTC') {
  const [t] = await getJson(`${UPBIT_URL}/ticker?markets=${encodeURIComponent(market)}`);
  if (!t || !(Number(t.trade_price) > 0)) throw new Error(`Upbit returned no price for ${market}`);
  return {
    market,
    price: Number(t.trade_price),
    change: Number(t.signed_change_price),
    change_pct: Number(t.signed_change_rate),
    traded_at: new Date(Number(t.trade_timestamp)).toISOString(),
    high_52w: Number(t.highest_52_week_price) || null,
    high_52w_date: t.highest_52_week_date || null,
    low_52w: Number(t.lowest_52_week_price) || null,
    low_52w_date: t.lowest_52_week_date || null,
  };
}

/** Fetch about `days` of daily candles for `instrument` and upsert them into prices. */
export async function fetchAndStoreUpbit(instrument, days = 365) {
  const market = UPBIT_MARKETS[instrument.symbol];
  if (!market) throw new Error(`${instrument.symbol} is not an Upbit instrument`);

  const rows = [];
  let to = null;
  for (let page = 0; page < MAX_PAGES && rows.length < days; page++) {
    if (page > 0) await sleep(PAGE_DELAY_MS);
    const count = Math.min(PAGE_SIZE, Math.max(1, days - rows.length));
    const url = `${UPBIT_URL}/candles/days?market=${market}&count=${count}${to ? `&to=${encodeURIComponent(to)}` : ''}`;
    const candles = await getJson(url);
    if (!Array.isArray(candles) || candles.length === 0) break;
    rows.push(...parseCandles(candles));
    // Next page: candles before the oldest one seen.
    to = `${candles[candles.length - 1].candle_date_time_utc}Z`;
    if (candles.length < count) break;
  }

  let inserted = 0;
  const conn = await pool.getConnection();
  try {
    for (const r of rows) {
      const [res] = await conn.execute(
        `INSERT INTO prices (instrument_id, trade_date, open_px, high_px, low_px, close_px)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE open_px=VALUES(open_px), high_px=VALUES(high_px),
                                 low_px=VALUES(low_px), close_px=VALUES(close_px)`,
        [instrument.id, r.trade_date, r.open_px, r.high_px, r.low_px, r.close_px]
      );
      if (res.affectedRows > 0) inserted++;
    }
  } finally {
    conn.release();
  }

  return {
    symbol: instrument.symbol,
    fetched: rows.length,
    inserted_or_updated: inserted,
    latest: rows.length ? rows[0].close_px : null,
  };
}
