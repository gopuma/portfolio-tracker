/**
 * Startup catch-up for the nightly refresh: find the last scheduled time and decide
 * whether it was missed. Uses node-cron's real matcher with the job's schedule and timezone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';
import { previousScheduledRun, missedRun } from '../src/jobs/dailyPriceJob.js';

// createTask builds a matcher without starting a timer.
const task = cron.createTask('30 6 * * 2-6', () => {}, { timezone: 'Asia/Seoul' });
const matches = d => task.match(d);

test('previous scheduled run: Tuesday evening KST → Tuesday 06:30 KST', () => {
  const prev = previousScheduledRun(matches, new Date('2026-09-15T10:32:45Z')); // Tue 19:32 KST
  assert.equal(prev.toISOString(), '2026-09-14T21:30:00.000Z'); // Tue 06:30 KST
});

test('previous scheduled run: Monday KST → Saturday 06:30 KST (no Sun/Mon runs)', () => {
  const prev = previousScheduledRun(matches, new Date('2026-09-14T03:00:00Z')); // Mon 12:00 KST
  assert.equal(prev.toISOString(), '2026-09-11T21:30:00.000Z'); // Sat 06:30 KST
});

test('previous scheduled run: exactly at fire time counts that fire', () => {
  const prev = previousScheduledRun(matches, new Date('2026-09-14T21:30:20Z'));
  assert.equal(prev.toISOString(), '2026-09-14T21:30:00.000Z');
});

const scheduledAt = new Date('2026-09-14T21:30:00Z');
const now = new Date('2026-09-15T10:32:00Z');

test('missed: last run finished before the scheduled time (backend was down)', () => {
  assert.equal(missedRun({ scheduledAt, lastStartedAt: new Date('2026-09-11T21:30:00Z'), lastFinishedAt: new Date('2026-09-11T21:33:00Z'), now }), true);
});

test('missed: no run ever recorded', () => {
  assert.equal(missedRun({ scheduledAt, now }), true);
});

test('not missed: a run finished after the scheduled time', () => {
  assert.equal(missedRun({ scheduledAt, lastStartedAt: new Date('2026-09-14T21:30:00Z'), lastFinishedAt: new Date('2026-09-14T21:34:00Z'), now }), false);
});

test('not missed: a run started recently and may still be going', () => {
  assert.equal(missedRun({ scheduledAt, lastStartedAt: new Date(now - 5 * 60e3), now }), false);
});

test('missed: a run started long ago but never finished (killed mid-run)', () => {
  assert.equal(missedRun({ scheduledAt, lastStartedAt: new Date('2026-09-14T21:30:00Z'), now }), true);
});

test('not missed: nothing scheduled within the lookback', () => {
  assert.equal(missedRun({ scheduledAt: null, now }), false);
});

test('refresh window: a week normally, back to the last price after a gap, five years when empty', async () => {
  const { refreshDays, nextScheduledRun } = await import('../src/jobs/dailyPriceJob.js');
  const today = '2026-10-26';
  assert.equal(refreshDays({ latest: '2026-10-23', rows: 1200 }, today), 7);
  // Off for three weeks: fetch back past the last stored close.
  assert.equal(refreshDays({ latest: '2026-10-01', rows: 1200 }, today), 28);
  // Never fetched, or only a few rows: the full backfill.
  assert.equal(refreshDays({ latest: null, rows: 0 }, today), 1825);
  assert.equal(refreshDays({ latest: '2026-10-23', rows: 5 }, today), 1825);
  // A recent listing with a few months of history is refreshed normally.
  assert.equal(refreshDays({ latest: '2026-10-23', rows: 93 }, today), 7);
  // Next run: Saturday afternoon KST → Tuesday 06:30 KST.
  const next = nextScheduledRun(matches, new Date('2026-10-24T06:00:00Z'));
  assert.equal(next.toISOString(), '2026-10-26T21:30:00.000Z');
});
