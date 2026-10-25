/**
 * Annualizing daily stats for assets that trade every day (bitcoin) vs five days a week.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { riskStats, CALENDAR_DAYS } from '../src/services/stats.js';

// A year of daily closes growing a steady 0.1% a day, with a wobble so volatility isn't zero.
function series(n) {
  const out = [];
  let px = 100;
  const d = new Date('2025-01-01T00:00:00Z');
  for (let i = 0; i <= n; i++) {
    out.push({ date: d.toISOString().slice(0, 10), close: px });
    px *= 1.001 * (i % 2 ? 1.01 : 1 / 1.01);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

test('a year of 365 daily returns: CAGR is the year\'s return only when annualized by 365', () => {
  const s = series(365);
  const crypto = riskStats(s, 0, CALENDAR_DAYS);
  assert.ok(Math.abs(crypto.cagr - crypto.total_return) < 1e-12);
  // The 252-day default treats those 365 returns as about 1.45 years.
  assert.ok(riskStats(s).cagr < crypto.total_return);
});

test('volatility scales with the square root of the periods per year', () => {
  const s = series(365);
  const ratio = riskStats(s, 0, CALENDAR_DAYS).vol / riskStats(s).vol;
  assert.ok(Math.abs(ratio - Math.sqrt(365 / 252)) < 1e-12);
});
