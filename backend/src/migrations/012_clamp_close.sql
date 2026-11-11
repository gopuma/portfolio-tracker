-- A close outside the day's own low–high range never traded: Yahoo's FX pairs sometimes
-- report a stale snapshot as the close (KRW=X on 2026-11-02: 1325.52 under a low of
-- 1334.23). New fetches clamp it on the way in (priceFetcher clampClose). This does the
-- same to rows already stored, leaving bars with a missing or inverted range alone.
-- Idempotent: once clamped, a row no longer matches.

UPDATE prices
   SET close_px = LEAST(GREATEST(close_px, low_px), high_px)
 WHERE low_px > 0 AND high_px >= low_px
   AND (close_px < low_px OR close_px > high_px);
