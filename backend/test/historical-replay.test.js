/**
 * The pure pieces of the historical replay: drawdown, choosing a holding's source series,
 * splicing exchange rates across the Yahoo/FRED boundary, and the T-bill index.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  maxDrawdown, coversWindow, pickSource, chainFor, fxConverter, tbillIndex, REPLAY_EVENTS,
} from '../src/services/historicalReplay.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const rows = (pairs) => pairs.map(([date, value]) => ({ date, value }));

test('max drawdown is the worst fall from a running peak, with its dates', () => {
  // 100 → 120 (peak) → 90 (trough, −25%) → 130 → 117 (−10%)
  const dd = maxDrawdown([100, 120, 90, 130, 117]);
  assert.ok(close(dd.dd, -0.25));
  assert.equal(dd.peakIdx, 1);
  assert.equal(dd.troughIdx, 2);
});

test('a path that only rises has no drawdown', () => {
  assert.deepEqual(maxDrawdown([1, 2, 3]), { dd: 0, peakIdx: 0, troughIdx: 0 });
});

test('coversWindow needs a price near each end and no long hole', () => {
  // Right first and last dates, but months-long holes between them (like KODEX 200's
  // missing 2007–09 on Yahoo): not covered.
  const holey = rows([['2007-10-05', 1], ['2007-10-09', 1], ['2008-06-01', 1], ['2009-03-09', 1]]);
  assert.equal(coversWindow(holey, '2007-10-09', '2009-03-09'), false);

  const daily = [];
  for (let t = Date.parse('2007-10-01'); t <= Date.parse('2009-03-09'); t += 86400000) {
    daily.push({ date: new Date(t).toISOString().slice(0, 10), value: 1 });
  }
  assert.equal(coversWindow(daily, '2007-10-09', '2009-03-09'), true);
  // Starts after the event does.
  assert.equal(coversWindow(daily.filter(r => r.date >= '2007-11-01'), '2007-10-09', '2009-03-09'), false);
  // Stops well before the end.
  assert.equal(coversWindow(daily.filter(r => r.date <= '2009-01-31'), '2007-10-09', '2009-03-09'), false);
});

test('pickSource takes the first series in the chain that covers the event', () => {
  const daily = (from, to) => {
    const out = [];
    for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) out.push({ date: new Date(t).toISOString().slice(0, 10), value: 1 });
    return out;
  };
  const bySeries = new Map([
    ['NVDA', daily('1999-01-22', '2026-10-14')],
    ['^SOX', daily('1994-05-04', '2026-10-14')],
    ['^NDX', daily('1985-10-01', '2026-10-14')],
  ]);
  const chain = ['NVDA', '^SOX', '^NDX'];
  assert.equal(pickSource(chain, bySeries, '2000-03-10', '2002-10-09'), 'NVDA');
  assert.equal(pickSource(chain, bySeries, '1997-06-17', '1998-06-16'), '^SOX');
  assert.equal(pickSource(chain, bySeries, '1987-08-25', '1987-12-04'), '^NDX');
  assert.equal(pickSource(['^SOX'], bySeries, '1987-08-25', '1987-12-04'), null);
});

test('the factor basis leaves a holding\'s own prices out; the actual basis puts them first', () => {
  assert.deepEqual(chainFor('NVDA', 'US'), ['^SOX', '^NDX']);
  assert.deepEqual(chainFor('NVDA', 'US', 'actual'), ['NVDA', '^SOX', '^NDX']);
  // Unmapped symbols fall back to their market's index.
  assert.deepEqual(chainFor('XYZ', 'KR'), ['^KS11']);
  assert.deepEqual(chainFor('XYZ', 'US'), ['^GSPC']);
  // Bitcoin in won follows the global price; any other coin follows bitcoin.
  assert.deepEqual(chainFor('UPBIT-KRW-BTC', 'CRYPTO'), ['BTC-USD']);
  assert.deepEqual(chainFor('UPBIT-KRW-BTC', 'CRYPTO', 'actual'), ['UPBIT-KRW-BTC', 'BTC-USD']);
  assert.deepEqual(chainFor('ETH-USD', 'CRYPTO'), ['BTC-USD']);
});

test('USD/KRW uses Yahoo where it exists and FRED before it', () => {
  const fx = fxConverter(new Map([
    ['KRW=X', rows([['2003-12-01', 1200], ['2003-12-02', 1190]])],
    ['FRED:DEXKOUS', rows([['1997-06-17', 890], ['1997-12-23', 1962], ['2003-12-01', 9999]])],
    ['FRED:DEXJPUS', rows([['1997-06-17', 110]])],
  ]));
  // One won in dollars at the FRED rate, and the won's fall through the Asian crisis.
  assert.ok(close(fx('KRW', 'USD', '1997-06-17'), 1 / 890));
  assert.ok(close(fx('KRW', 'USD', '1997-12-23') / fx('KRW', 'USD', '1997-06-17') - 1, 890 / 1962 - 1));
  // From Yahoo's first date on, Yahoo wins over FRED's (deliberately wrong) 9999.
  assert.ok(close(fx('USD', 'KRW', '2003-12-01'), 1200));
  // JPY before Dec 2003 is crossed through the dollar: KRW per JPY = DEXKOUS / DEXJPUS.
  assert.ok(close(fx('JPY', 'KRW', '1997-06-17'), 890 / 110));
  assert.equal(fx('USD', 'USD', '1997-06-17'), 1);
});

test('T-bill index accrues the prior day\'s rate over calendar days, discount basis /360', () => {
  const idx = tbillIndex(rows([['2020-01-02', 3.6], ['2020-01-03', 3.6], ['2020-01-06', 0]]));
  assert.equal(idx[0].value, 1);
  assert.ok(close(idx[1].value, 1 + 0.036 / 360));
  // Friday to Monday is three days at Friday's rate.
  assert.ok(close(idx[2].value, (1 + 0.036 / 360) * (1 + 0.036 * 3 / 360)));
});

test('event windows are well formed', () => {
  const keys = new Set();
  for (const e of REPLAY_EVENTS) {
    assert.ok(!keys.has(e.key), `duplicate ${e.key}`);
    keys.add(e.key);
    assert.match(e.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.end === null || e.end > e.start, e.key);
    assert.ok(['crash', 'boom'].includes(e.kind), e.key);
  }
});
