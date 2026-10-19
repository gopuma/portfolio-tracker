/**
 * Domestic gold spot (KRW/g) from Naver, stored as KRX-GOLD-SPOT.
 * Yahoo Finance doesn't carry this; Naver publishes the daily 매매기준율 (국내 금, CMDT_GD).
 *
 * Daily history: https://api.stock.naver.com/marketindex/metals/CMDT_GD/prices?page=N&pageSize=50
 * (JSON, newest first, back to 2014). It replaced the HTML page
 * finance.naver.com/marketindex/goldDailyQuote.naver, which Naver retired in September 2026
 * (it now answers 410 Gone) and which carried the same series.
 */
import { pool } from '../db.js';

const NAVER_LIVE_URL = 'https://api.stock.naver.com/marketindex/metals/CMDT_GD';
const NAVER_HISTORY_URL = `${NAVER_LIVE_URL}/prices`;
const PAGE_SIZE = 50; // the API allows up to 60
const PAGE_DELAY_MS = Number(process.env.NAVER_PAGE_DELAY_MS || 800);
// Safety stop on paging, not a history limit: pages are only requested as far back as the
// caller's `days` asks for, and the walk also stops as soon as a page adds nothing new.
// 120 pages ≈ 6000 trading days, more than the API's history; the daily job asks for one.
const MAX_PAGES_CAP = Number(process.env.NAVER_MAX_PAGES || 120);
// A hung Naver response must not stall the request or the nightly job indefinitely.
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Live KRX gold spot from Naver's mobile API. Returns realtime tick during KRX hours,
 * latest close otherwise.
 */
export async function fetchLiveKrxGold() {
  const res = await fetch(NAVER_LIVE_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (portfolio-tracker krxGoldFetcher)' },
  });
  if (!res.ok) throw new Error(`Naver metals API HTTP ${res.status}`);
  const d = await res.json();
  const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));
  return {
    symbol: 'KRX-GOLD-SPOT',
    price_krw_per_g: num(d.closePrice),
    fluctuation_krw: num(d.fluctuations),
    fluctuation_pct: d.fluctuationsRatio != null ? Number(d.fluctuationsRatio) / 100 : null,
    direction: d.fluctuationsType?.name || null, // RISING / FALLING / FLAT
    market_status: d.marketStatus || null,       // OPEN / CLOSE
    price_data_type: d.priceDataType || null,    // REALTIME
    local_traded_at: d.localTradedAt || null,
    unit: d.unit || null,
    source_name: d.name || null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page) {
  const res = await fetch(`${NAVER_HISTORY_URL}?page=${page}&pageSize=${PAGE_SIZE}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (portfolio-tracker krxGoldFetcher)' },
  });
  if (!res.ok) throw new Error(`Naver gold history page ${page} HTTP ${res.status}`);
  return res.json();
}

// Each row: { localTradedAt: '2026-10-16T00:00:00+09:00', closePrice: '179,073.79', ... }
export function parseRows(items) {
  if (!Array.isArray(items)) return [];
  const rows = [];
  for (const it of items) {
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(it?.localTradedAt || '')?.[1];
    const px = Number(String(it?.closePrice ?? '').replace(/,/g, ''));
    if (date && Number.isFinite(px) && px > 0) rows.push({ trade_date: date, close_px: px });
  }
  return rows;
}

/**
 * @param {{id:number, symbol:string}} instrument
 * @param {number} days  Approximate calendar days back to fetch
 */
export async function fetchAndStoreKrxGoldSpot(instrument, days = 365) {
  // A page of 50 trading days covers about 70 calendar days.
  const targetPages = Math.min(MAX_PAGES_CAP, Math.max(1, Math.ceil(days / 70)));
  const seen = new Set();
  const allRows = [];

  for (let p = 1; p <= targetPages; p++) {
    if (p > 1) await sleep(PAGE_DELAY_MS);
    const rows = parseRows(await fetchPage(p));
    if (rows.length === 0) break; // no more history
    let added = 0;
    for (const r of rows) {
      if (seen.has(r.trade_date)) continue;
      seen.add(r.trade_date);
      allRows.push(r);
      added++;
    }
    if (added === 0) break; // page repeated; bail
  }

  if (allRows.length === 0) {
    return { symbol: instrument.symbol, fetched: 0, inserted_or_updated: 0, note: 'No rows parsed from Naver' };
  }

  allRows.sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));

  const conn = await pool.getConnection();
  let inserted = 0;
  try {
    for (const r of allRows) {
      const [res] = await conn.execute(
        `INSERT INTO prices (instrument_id, trade_date, close_px)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE close_px=VALUES(close_px)`,
        [instrument.id, r.trade_date, r.close_px]
      );
      if (res.affectedRows > 0) inserted++;
    }
  } finally {
    conn.release();
  }

  return {
    symbol: instrument.symbol,
    fetched: allRows.length,
    inserted_or_updated: inserted,
    latest: allRows[allRows.length - 1].close_px,
  };
}
