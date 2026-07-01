/**
 * Seed the instruments table with tracked tickers from the user's portfolio.
 * Run after migration: `npm run seed`
 */
import '../src/env.js';
import { pool } from '../src/db.js';

// NOTE: Korean ETF Yahoo tickers (KS suffix) — verify these match your broker.
// If a ticker is wrong, update it and re-run `npm run seed`.
const INSTRUMENTS = [
  // US ETFs
  { symbol: 'SGOV',  display_name: 'iShares 0-3 Month Treasury Bond ETF',     asset_class: 'BOND_ETF', currency: 'USD', market: 'US', category: 'ultra-short-treasury' },
  { symbol: 'JPST',  display_name: 'JPMorgan Ultra-Short Income ETF',         asset_class: 'BOND_ETF', currency: 'USD', market: 'US', category: 'ultra-short-bond' },
  { symbol: 'JAAA',  display_name: 'Janus Henderson AAA CLO ETF',             asset_class: 'BOND_ETF', currency: 'USD', market: 'US', category: 'aaa-clo' },
  { symbol: 'SCHD',  display_name: 'Schwab US Dividend Equity ETF',           asset_class: 'ETF',      currency: 'USD', market: 'US', category: 'dividend-value' },
  { symbol: 'QQQ',   display_name: 'Invesco QQQ Trust',                       asset_class: 'ETF',      currency: 'USD', market: 'US', category: 'nasdaq-100' },
  { symbol: 'QQQM',  display_name: 'Invesco NASDAQ 100 ETF',                  asset_class: 'ETF',      currency: 'USD', market: 'US', category: 'nasdaq-100' },

  // Gold (intl spot, USD/oz)
  { symbol: 'GC=F',  display_name: 'Gold Futures (USD/oz)',                   asset_class: 'COMMODITY',currency: 'USD', market: 'US', category: 'intl-gold-spot', notes: 'COMEX continuous gold futures, USD/oz. International spot proxy.' },

  // FX (used to convert KRX gold KRW into USD for the gold-gap calculation)
  { symbol: 'KRW=X', display_name: 'USD/KRW Spot',                            asset_class: 'CASH',     currency: 'KRW', market: 'FX', category: 'fx-usdkrw',      notes: 'KRW per USD. Hidden from market sections; used by /api/gold-gap.' },
  { symbol: 'JPYKRW=X', display_name: 'JPY/KRW Spot',                         asset_class: 'CASH',     currency: 'KRW', market: 'FX', category: 'fx-jpykrw',      notes: 'KRW per JPY. Shown on the overview FX cards.' },

  // Volatility index (market indicator — hidden from holdings/analytics, shown on its own card)
  { symbol: '^VIX',  display_name: 'CBOE Volatility Index (VIX)',             asset_class: 'ETF',      currency: 'USD', market: 'INDEX', category: 'volatility-index', notes: 'CBOE VIX — implied 30-day S&P 500 volatility. asset_class is a placeholder (ENUM); excluded from holdings & analytics.' },

  // Market benchmarks for CAPM alpha/beta (hidden from holdings/analytics; asset_class is an ENUM placeholder)
  { symbol: '^GSPC', display_name: 'S&P 500 Index',                           asset_class: 'ETF',      currency: 'USD', market: 'INDEX', category: 'benchmark-us', notes: 'US market benchmark for alpha/beta of US instruments.' },
  { symbol: '^IXIC', display_name: 'NASDAQ Composite Index',                  asset_class: 'ETF',      currency: 'USD', market: 'INDEX', category: 'benchmark-us', notes: 'NASDAQ Composite — shown on the overview index cards.' },
  { symbol: '^DJI',  display_name: 'Dow Jones Industrial Average',            asset_class: 'ETF',      currency: 'USD', market: 'INDEX', category: 'benchmark-us', notes: 'Dow Jones Industrial Average — shown on the overview index cards.' },
  { symbol: '^SOX',  display_name: 'PHLX Semiconductor Index',                asset_class: 'ETF',      currency: 'USD', market: 'INDEX', category: 'benchmark-us', notes: 'Philadelphia Semiconductor Index (SOX) — shown on the overview index cards.' },
  { symbol: '^KS11', display_name: 'KOSPI Composite Index',                   asset_class: 'ETF',      currency: 'KRW', market: 'INDEX', category: 'benchmark-kr', notes: 'Korean market benchmark for alpha/beta of KR instruments.' },

  // US Stocks / mREIT
  { symbol: 'AMZN',  display_name: 'Amazon.com Inc.',                         asset_class: 'STOCK',    currency: 'USD', market: 'US', category: 'mega-cap-tech' },
  { symbol: 'TSLA',  display_name: 'Tesla Inc.',                              asset_class: 'STOCK',    currency: 'USD', market: 'US', category: 'mega-cap-tech' },
  { symbol: 'AGNC',  display_name: 'AGNC Investment Corp.',                   asset_class: 'REIT',     currency: 'USD', market: 'US', category: 'mortgage-reit' },
  { symbol: 'NLY',   display_name: 'Annaly Capital Management',               asset_class: 'REIT',     currency: 'USD', market: 'US', category: 'mortgage-reit' },

  // Korean ETFs (verify tickers with your broker — Yahoo uses .KS suffix for KOSPI)
  { symbol: '466920.KS', display_name: 'TIMEFOLIO 미국나스닥100액티브 ETF',     asset_class: 'ETF', currency: 'KRW', market: 'KR', category: 'nasdaq-100-active',  notes: 'Verify ticker; Yahoo coverage may be patchy.' },
  { symbol: '458730.KS', display_name: 'TIGER 미국배당다우존스',                asset_class: 'ETF', currency: 'KRW', market: 'KR', category: 'us-dividend-dj',     notes: 'Tracks Dow Jones US Dividend 100.' },
  { symbol: '472160.KS', display_name: 'TIGER 미국초단기국채액티브 ETF',        asset_class: 'BOND_ETF', currency: 'KRW', market: 'KR', category: 'ultra-short-treasury' },
  { symbol: 'KRX-GOLD-SPOT', display_name: 'KRX 금현물 (KRW/g)',                asset_class: 'COMMODITY', currency: 'KRW', market: 'KR', category: 'krx-gold-spot', notes: 'KRX 금현물 매매기준율, scraped daily from Naver Finance (finance.naver.com/marketindex).' },
];

async function seed() {
  const conn = await pool.getConnection();
  try {
    console.log(`Seeding ${INSTRUMENTS.length} instruments...`);
    for (const inst of INSTRUMENTS) {
      await conn.execute(
        `INSERT INTO instruments (symbol, display_name, asset_class, currency, market, category, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           display_name = VALUES(display_name),
           asset_class  = VALUES(asset_class),
           currency     = VALUES(currency),
           market       = VALUES(market),
           category     = VALUES(category),
           notes        = VALUES(notes)`,
        [inst.symbol, inst.display_name, inst.asset_class, inst.currency, inst.market, inst.category, inst.notes || null]
      );
      console.log(`  ✓ ${inst.symbol.padEnd(12)} ${inst.display_name}`);
    }
    console.log('Done.');
  } finally {
    conn.release();
    await pool.end();
  }
}

seed().catch(err => { console.error(err); process.exit(1); });
