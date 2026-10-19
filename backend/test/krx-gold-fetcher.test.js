/**
 * Parsing Naver's daily gold history (api.stock.naver.com/marketindex/metals/CMDT_GD/prices).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRows } from '../src/services/krxGoldFetcher.js';

test('rows give the Seoul trade date and the comma-free close', () => {
  const rows = parseRows([
    { localTradedAt: '2026-10-16T00:00:00+09:00', closePrice: '179,073.79', fluctuations: '-1,120.38' },
    { localTradedAt: '2026-10-15T00:00:00+09:00', closePrice: '180,194.17' },
  ]);
  assert.deepEqual(rows, [
    { trade_date: '2026-10-16', close_px: 179073.79 },
    { trade_date: '2026-10-15', close_px: 180194.17 },
  ]);
});

test('anything that is not a dated, positive price is skipped', () => {
  assert.deepEqual(parseRows({ detailCode: 'too_small' }), []);
  assert.deepEqual(parseRows([{ localTradedAt: '', closePrice: '1' }, { localTradedAt: '2026-10-16T00:00:00+09:00', closePrice: '-' }]), []);
});
