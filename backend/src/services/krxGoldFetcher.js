/**
 * Scrape KRX 금현물 spot (KRW/g) from Naver Finance.
 * Yahoo Finance doesn't carry this; Naver publishes the official 매매기준율 daily.
 *
 * Source page: https://finance.naver.com/marketindex/goldDailyQuote.naver?page=N
 * Each page has ~10 trading days. Charset is EUC-KR but date/number fields are ASCII.
 */
import { pool } from '../db.js';

const NAVER_URL = 'https://finance.naver.com/marketindex/goldDailyQuote.naver';
const NAVER_LIVE_URL = 'https://api.stock.naver.com/marketindex/metals/CMDT_GD';
const PAGE_DELAY_MS = Number(process.env.NAVER_PAGE_DELAY_MS || 800);
const MAX_PAGES_CAP = 40;

/**
 * Live KRX gold spot from Naver's mobile API. Returns realtime tick during KRX hours,
 * latest close otherwise.
 */
export async function fetchLiveKrxGold() {
  const res = await fetch(NAVER_LIVE_URL, {
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
  const res = await fetch(`${NAVER_URL}?page=${page}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (portfolio-tracker krxGoldFetcher)' },
  });
  if (!res.ok) throw new Error(`Naver page ${page} HTTP ${res.status}`);
  return res.text();
}

// Each row: <tr class="up|down"> ... <td class="date">YYYY.MM.DD</td> <td class="num">123,456.78</td> ...
const ROW_RE = /<td class="date">(\d{4})\.(\d{2})\.(\d{2})<\/td>\s*<td class="num">([\d,.]+)<\/td>/g;

function parseRows(html) {
  const rows = [];
  let m;
  while ((m = ROW_RE.exec(html)) !== null) {
    const [, y, mo, d, priceStr] = m;
    rows.push({
      trade_date: `${y}-${mo}-${d}`,
      close_px: Number(priceStr.replace(/,/g, '')),
    });
  }
  return rows;
}

/**
 * @param {{id:number, symbol:string}} instrument
 * @param {number} days  Approximate calendar days back to fetch
 */
export async function fetchAndStoreKrxGoldSpot(instrument, days = 365) {
  const targetPages = Math.min(MAX_PAGES_CAP, Math.max(1, Math.ceil(days / 10)));
  const seen = new Set();
  const allRows = [];

  for (let p = 1; p <= targetPages; p++) {
    if (p > 1) await sleep(PAGE_DELAY_MS);
    const html = await fetchPage(p);
    const rows = parseRows(html);
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
