/**
 * Parsing Upbit's daily candles (api.upbit.com/v1/candles/days).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandles, UPBIT_MARKETS } from '../src/services/upbitFetcher.js';

test('candles give the UTC candle date and OHLC in won', () => {
  const rows = parseCandles([
    {
      market: 'KRW-BTC',
      candle_date_time_utc: '2026-10-24T00:00:00',
      candle_date_time_kst: '2026-10-24T09:00:00',
      opening_price: 108879000.0,
      high_price: 108928000.0,
      low_price: 106821000.0,
      trade_price: 108517000.0,
    },
  ]);
  assert.deepEqual(rows, [
    { trade_date: '2026-10-24', open_px: 108879000, high_px: 108928000, low_px: 106821000, close_px: 108517000 },
  ]);
});

test('anything that is not a dated, positive price is skipped', () => {
  assert.deepEqual(parseCandles(null), []);
  assert.deepEqual(parseCandles([{ candle_date_time_utc: 'x', trade_price: 1 }, { candle_date_time_utc: '2026-10-24T00:00:00', trade_price: 0 }]), []);
});

test('the won bitcoin instrument maps to Upbit\'s KRW-BTC market', () => {
  assert.equal(UPBIT_MARKETS['UPBIT-KRW-BTC'], 'KRW-BTC');
});
