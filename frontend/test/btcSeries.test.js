import test from 'node:test';
import assert from 'node:assert/strict';
import { usdToKrw } from '../src/btcSeries.js';

test('dollars become won at each day\'s rate', () => {
  const usd = [{ t: '2026-10-23', v: 80_000 }];
  const fx = [{ t: '2026-10-23', v: 1300 }];
  assert.deepEqual(usdToKrw(usd, fx), [{ t: '2026-10-23', v: 104_000_000 }]);
});

test('weekends carry the last rate forward; days before any rate are dropped', () => {
  const usd = [{ t: '2026-10-22', v: 1 }, { t: '2026-10-24', v: 2 }, { t: '2026-10-25', v: 3 }];
  const fx = [{ t: '2026-10-23', v: 1300 }];
  assert.deepEqual(usdToKrw(usd, fx), [{ t: '2026-10-24', v: 2600 }, { t: '2026-10-25', v: 3900 }]);
});
