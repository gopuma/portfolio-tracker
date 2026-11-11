import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEOUL, zonedParts, ymd, nyseHolidays, nyseEarlyCloses, nySession,
  marketStatus, seoulDayBands, nextClockChange,
} from '../src/marketHours.js';

const seoul = ms => {
  const p = zonedParts(ms, SEOUL);
  return `${p.m}/${p.d} ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
};
const at = iso => Date.parse(iso);

test('2026 NYSE holidays, including weekend-observed ones', () => {
  const h = nyseHolidays(2026);
  assert.deepEqual([...h.keys()], [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
    '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  ]);
});

test("New Year's Day: Sunday moves to Monday, Saturday is not moved into the old year", () => {
  assert.ok(nyseHolidays(2023).has('2023-01-02'));
  assert.ok(!nyseHolidays(2022).has('2021-12-31'));
  assert.ok(![...nyseHolidays(2022).keys()].some(k => k.startsWith('2022-01-0')));
});

test('early closes: day after Thanksgiving, Christmas Eve, July 3 only Mon–Thu', () => {
  assert.deepEqual([...nyseEarlyCloses(2026).keys()], ['2026-11-27', '2026-12-24']);
  assert.deepEqual([...nyseEarlyCloses(2025).keys()], ['2025-07-03', '2025-11-28', '2025-12-24']);
  const s = nySession(ymd(2026, 11, 27));
  assert.equal(s.early, 'Day after Thanksgiving');
  assert.equal(seoul(s.regular[1]), '11/28 03:00');
});

test('regular session in Seoul time: 23:30–06:00 in winter, 22:30–05:00 in summer', () => {
  const winter = nySession(ymd(2026, 11, 10));
  assert.equal(seoul(winter.regular[0]), '11/10 23:30');
  assert.equal(seoul(winter.regular[1]), '11/11 06:00');
  assert.equal(seoul(winter.pre[0]), '11/10 18:00');
  assert.equal(seoul(winter.post[1]), '11/11 10:00');
  const summer = nySession(ymd(2026, 7, 1));
  assert.equal(seoul(summer.regular[0]), '7/1 22:30');
  assert.equal(seoul(summer.regular[1]), '7/2 05:00');
});

test('status while open, in pre-market, after hours and over a weekend', () => {
  const open = marketStatus(at('2026-11-10T15:00:00Z')); // 10:00 New York
  assert.equal(open.phase, 'open');
  assert.equal(open.closesAt, at('2026-11-10T21:00:00Z'));

  assert.equal(marketStatus(at('2026-11-10T12:00:00Z')).phase, 'pre');
  const post = marketStatus(at('2026-11-10T22:00:00Z'));
  assert.equal(post.phase, 'post');
  assert.equal(post.nextOpen, at('2026-11-11T14:30:00Z'));

  const sat = marketStatus(at('2026-11-14T15:00:00Z'));
  assert.equal(sat.phase, 'closed');
  assert.equal(sat.nextOpen, at('2026-11-16T14:30:00Z'));
});

test('Thanksgiving: closed all day, next open is the early-close Friday', () => {
  const s = marketStatus(at('2026-11-26T16:00:00Z'));
  assert.equal(s.phase, 'closed');
  assert.equal(s.closedToday, 'Thanksgiving Day');
  assert.equal(s.nextOpen, at('2026-11-27T14:30:00Z'));
  assert.equal(s.session.early, 'Day after Thanksgiving');
});

test('a Seoul day shows the end of last night\'s session and the start of tonight\'s', () => {
  const day = seoulDayBands(at('2026-11-10T05:00:00Z')); // Tue 14:00 Seoul
  const hours = day.bands.map(b => [b.kind, +(b.from * 24).toFixed(2), +(b.to * 24).toFixed(2)]);
  assert.deepEqual(hours, [
    ['regular', 0, 6], ['post', 6, 10], // Monday's New York session
    ['pre', 18, 23.5], ['regular', 23.5, 24], // Tuesday's
  ]);
  assert.equal(+(day.now * 24).toFixed(2), 14);
  assert.deepEqual(seoulDayBands(at('2026-11-15T05:00:00Z')).bands, []); // Sunday in Seoul
});

test('next US clock change from November is the second Sunday of March', () => {
  const c = nextClockChange(at('2026-11-10T05:00:00Z'));
  assert.equal(`${c.date.y}-${c.date.m}-${c.date.d}`, '2027-3-14');
  assert.equal(c.dstStarts, true);
  assert.equal(seoul(c.regular[0]).slice(-5), '22:30');
});
