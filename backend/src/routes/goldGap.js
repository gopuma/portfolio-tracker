import express from 'express';
import { query } from '../db.js';
import { fetchLiveKrxGold } from '../services/krxGoldFetcher.js';

export const goldGapRouter = express.Router();

const KRX_SYMBOL = 'KRX-GOLD-SPOT';
const INTL_SYMBOL = 'GC=F';
const FX_SYMBOL = 'KRW=X';
const GRAMS_PER_TROY_OZ = 31.1034768;

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

goldGapRouter.get('/', async (_req, res, next) => {
  try {
    const [krx, intl, fx, liveKrxSettled] = await Promise.all([
      latestAndPrior(KRX_SYMBOL, 30),
      latestAndPrior(INTL_SYMBOL, 30),
      latestAndPrior(FX_SYMBOL, 30),
      fetchLiveKrxGold().catch((e) => ({ error: e.message })),
    ]);

    if (!krx || !intl || !fx) {
      return res.status(404).json({ error: 'Missing one or more required instruments', need: [KRX_SYMBOL, INTL_SYMBOL, FX_SYMBOL] });
    }

    const liveKrx = liveKrxSettled && !liveKrxSettled.error ? liveKrxSettled : null;
    const krxEod = Number(krx.latest);
    // Prefer live KRX price if Naver returned a usable value; else fall back to DB EOD.
    const krxKrwPerG = liveKrx?.price_krw_per_g ?? krxEod;
    const intlLatest = Number(intl.latest);
    const fxLatest = Number(fx.latest);

    const ret30 = (l, p) => (l && p ? l / Number(p) - 1 : null);
    const krxRet30 = ret30(krxKrwPerG, krx.prior);
    const intlRet30 = ret30(intlLatest, intl.prior);

    const intlKrwPerOz = intlLatest * fxLatest;
    const intlKrwPerG = intlKrwPerOz / GRAMS_PER_TROY_OZ;

    const premiumKrwPerG = krxKrwPerG - intlKrwPerG;
    const premiumPct = intlKrwPerG ? premiumKrwPerG / intlKrwPerG : null;

    res.json({
      krx: {
        symbol: krx.symbol,
        display_name: krx.display_name,
        currency: krx.currency,
        latest_krw_per_g: krxKrwPerG,
        latest_date: krx.latest_date,
        eod_krw_per_g: krxEod,
        return_30d: krxRet30,
        live: liveKrx, // null if Naver live API failed; the route still returns EOD values
      },
      intl: {
        symbol: intl.symbol,
        display_name: intl.display_name,
        currency: intl.currency,
        latest_usd_per_oz: intlLatest,
        latest_date: intl.latest_date,
        return_30d: intlRet30,
        latest_krw_per_oz: intlKrwPerOz,
        latest_krw_per_g: intlKrwPerG,
      },
      fx: {
        symbol: fx.symbol,
        krw_per_usd: fxLatest,
        latest_date: fx.latest_date,
      },
      gap: {
        premium_krw_per_g: premiumKrwPerG,
        premium_pct: premiumPct,
        return_30d_diff: krxRet30 != null && intlRet30 != null ? krxRet30 - intlRet30 : null,
        note: 'Premium = (KRX − Intl) per gram, KRW. Intl gold converted via GC=F × USD/KRW ÷ 31.1035.',
      },
    });
  } catch (e) { next(e); }
});
