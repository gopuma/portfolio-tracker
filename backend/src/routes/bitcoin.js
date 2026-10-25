import express from 'express';
import { query } from '../db.js';
import { fetchLiveUpbit } from '../services/upbitFetcher.js';
import { fetchQuotes } from '../services/priceFetcher.js';

export const bitcoinRouter = express.Router();

const UPBIT_SYMBOL = 'UPBIT-KRW-BTC';
const GLOBAL_SYMBOL = 'BTC-USD';
const FX_SYMBOL = 'KRW=X';

// Latest stored close, and the close on or before `daysBack` days ago.
async function latestAndPrior(symbol, daysBack) {
  const rows = await query(
    `SELECT i.id, i.symbol, i.display_name, i.currency,
            lp.close_px AS latest, lp.trade_date AS latest_date,
            (SELECT close_px FROM prices p2
               WHERE p2.instrument_id = i.id
                 AND p2.trade_date <= DATE_SUB(CURDATE(), INTERVAL ? DAY)
               ORDER BY p2.trade_date DESC LIMIT 1) AS prior
       FROM instruments i
       LEFT JOIN v_latest_prices lp ON lp.instrument_id = i.id
      WHERE i.symbol = ?`,
    [daysBack, symbol]
  );
  return rows[0] || null;
}

/**
 * Bitcoin on Upbit (KRW) against the global price (BTC-USD × USD/KRW): live prices when
 * the sources answer, else the latest stored closes, plus 30-day returns and the Korean
 * ("kimchi") premium.
 */
bitcoinRouter.get('/', async (_req, res, next) => {
  try {
    const [upbit, global, fx, liveUpbit, liveGlobal] = await Promise.all([
      latestAndPrior(UPBIT_SYMBOL, 30),
      latestAndPrior(GLOBAL_SYMBOL, 30),
      latestAndPrior(FX_SYMBOL, 30),
      fetchLiveUpbit('KRW-BTC').catch(() => null),
      fetchQuotes([GLOBAL_SYMBOL]).then(q => q[GLOBAL_SYMBOL] || null).catch(() => null),
    ]);
    if (!upbit || !global || !fx) {
      return res.status(404).json({ error: 'Missing one or more required instruments (run npm run migrate)', need: [UPBIT_SYMBOL, GLOBAL_SYMBOL, FX_SYMBOL] });
    }

    const upbitKrw = liveUpbit?.price ?? (upbit.latest != null ? Number(upbit.latest) : null);
    const globalUsd = liveGlobal?.price ?? (global.latest != null ? Number(global.latest) : null);
    const krwPerUsd = Number(fx.latest);
    const globalKrw = globalUsd != null && krwPerUsd ? globalUsd * krwPerUsd : null;

    const ret = (l, p) => (l && p ? l / Number(p) - 1 : null);
    const upbitRet30 = ret(upbitKrw, upbit.prior);
    const globalRet30 = ret(globalUsd, global.prior);
    // The global move in won, so it compares with Upbit without the exchange rate's move.
    const globalRet30Krw = global.prior && fx.prior ? ret(globalKrw, Number(global.prior) * Number(fx.prior)) : null;

    res.json({
      upbit: {
        symbol: upbit.symbol,
        display_name: upbit.display_name,
        latest_krw: upbitKrw,
        latest_date: upbit.latest_date,
        return_30d: upbitRet30,
        live: liveUpbit,
      },
      global: {
        symbol: global.symbol,
        display_name: global.display_name,
        latest_usd: globalUsd,
        latest_date: global.latest_date,
        latest_krw: globalKrw,
        return_30d: globalRet30,
        return_30d_krw: globalRet30Krw,
        live: liveGlobal,
      },
      fx: { symbol: fx.symbol, krw_per_usd: krwPerUsd, latest_date: fx.latest_date },
      premium: {
        krw: upbitKrw != null && globalKrw != null ? upbitKrw - globalKrw : null,
        pct: upbitKrw != null && globalKrw ? upbitKrw / globalKrw - 1 : null,
        return_30d_diff: upbitRet30 != null && globalRet30Krw != null ? upbitRet30 - globalRet30Krw : null,
        note: 'Premium = Upbit KRW-BTC ÷ (BTC-USD × USD/KRW) − 1.',
      },
    });
  } catch (e) { next(e); }
});
