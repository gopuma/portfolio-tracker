import express from 'express';
import { query } from '../db.js';

export const portfolioRouter = express.Router();

/**
 * Aggregate view: each tracked instrument with latest close, latest sentiment,
 * latest prediction, and 30-day return.
 */
portfolioRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await query(`
      SELECT
        i.id, i.symbol, i.display_name, i.asset_class, i.currency, i.market, i.category,
        lp.close_px AS latest_close,
        lp.trade_date AS latest_date,
        (
          SELECT close_px FROM prices p2
          WHERE p2.instrument_id = i.id
            AND p2.trade_date <= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
          ORDER BY p2.trade_date DESC LIMIT 1
        ) AS close_30d_ago,
        (
          SELECT close_px FROM prices p3
          WHERE p3.instrument_id = i.id
            AND p3.trade_date < MAKEDATE(YEAR(CURDATE()), 1)
          ORDER BY p3.trade_date DESC LIMIT 1
        ) AS close_ytd_start,
        (
          SELECT close_px FROM prices p4
          WHERE p4.instrument_id = i.id
            AND p4.trade_date <= DATE_SUB(CURDATE(), INTERVAL 3 YEAR)
          ORDER BY p4.trade_date DESC LIMIT 1
        ) AS close_3y_ago,
        (
          SELECT score FROM sentiment_scores s
          WHERE s.instrument_id = i.id
          ORDER BY score_date DESC LIMIT 1
        ) AS latest_sentiment,
        pr.predicted_price,
        pr.predicted_return,
        pr.confidence,
        pr.prediction_date,
        pr.horizon_days
      FROM instruments i
      LEFT JOIN v_latest_prices lp ON lp.instrument_id = i.id
      LEFT JOIN (
        SELECT p.*
        FROM predictions p
        INNER JOIN (
          SELECT instrument_id, MAX(prediction_date) AS d
          FROM predictions GROUP BY instrument_id
        ) m ON m.instrument_id = p.instrument_id AND m.d = p.prediction_date
      ) pr ON pr.instrument_id = i.id
      WHERE i.is_active = 1 AND i.watchlist = 1
      ORDER BY i.market, i.symbol
    `);

    // Compute 30-day, YTD, and 3-year % returns server-side
    const enriched = rows.map(r => ({
      ...r,
      return_30d: r.close_30d_ago && r.latest_close
        ? Number(r.latest_close) / Number(r.close_30d_ago) - 1
        : null,
      return_ytd: r.close_ytd_start && r.latest_close
        ? Number(r.latest_close) / Number(r.close_ytd_start) - 1
        : null,
      return_3y: r.close_3y_ago && r.latest_close
        ? Number(r.latest_close) / Number(r.close_3y_ago) - 1
        : null,
    }));

    res.json({ count: enriched.length, instruments: enriched });
  } catch (e) { next(e); }
});
