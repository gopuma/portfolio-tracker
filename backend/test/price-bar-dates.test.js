/**
 * Daily bars are dated in the exchange's timezone. Yahoo's FX pairs open at London
 * midnight, which is 23:00 UTC the day before during British Summer Time — a UTC reading
 * filed those bars a day early.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { quotesToBars } from '../src/services/priceFetcher.js';

const q = (iso, close) => ({ date: new Date(iso), open: close, high: close, low: close, close, volume: 0 });

test('FX bar at London midnight during BST keeps its London date', () => {
  // Monday 2026-09-14's KRW=X bar, as Yahoo timestamps it.
  const bars = quotesToBars([q('2026-09-13T23:00:00Z', 1344.64)], 'Europe/London');
  assert.equal(bars[0].trade_date, '2026-09-14');
});

test('FX bar at London midnight in winter (GMT) is unchanged', () => {
  const bars = quotesToBars([q('2026-01-12T00:00:00Z', 1450)], 'Europe/London');
  assert.equal(bars[0].trade_date, '2026-01-12');
});

test('New York, Seoul, and Chicago bars keep the dates a UTC reading gave them', () => {
  assert.equal(quotesToBars([q('2026-09-14T13:30:00Z', 333.08)], 'America/New_York')[0].trade_date, '2026-09-14');
  assert.equal(quotesToBars([q('2026-09-15T00:00:00Z', 6627)], 'Asia/Seoul')[0].trade_date, '2026-09-15');
  assert.equal(quotesToBars([q('2026-09-14T07:00:00Z', 17.4)], 'America/Chicago')[0].trade_date, '2026-09-14');
});

test('drops bars without a close; on a date collision the later bar wins; output is date-sorted', () => {
  // Chronological, as Yahoo returns them.
  const bars = quotesToBars([
    q('2026-09-10T23:00:00Z', 1348.17),
    { date: new Date('2026-09-11T23:00:00Z'), close: null },
    q('2026-09-14T23:00:00Z', 1359.83),            // today's session bar…
    q('2026-09-15T10:36:00Z', 1360.68),            // …and the live one, same London date
  ], 'Europe/London');
  assert.deepEqual(bars.map(b => [b.trade_date, b.close_px]), [['2026-09-11', 1348.17], ['2026-09-15', 1360.68]]);
});

test('missing or unknown timezone falls back to UTC', () => {
  assert.equal(quotesToBars([q('2026-09-13T23:00:00Z', 1)], undefined)[0].trade_date, '2026-09-13');
  assert.equal(quotesToBars([q('2026-09-13T23:00:00Z', 1)], 'Not/AZone')[0].trade_date, '2026-09-13');
});
