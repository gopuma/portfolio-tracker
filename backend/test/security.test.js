/**
 * Local-only request guard: requests must be addressed to loopback, come from the app's own
 * origin (or a non-browser tool), and carry the client header when they change state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { localRequestGuard, safeHttpUrl, runExclusive } from '../src/security.js';

function run(method, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method, headers: lower, get: name => lower[name.toLowerCase()] };
  const out = { status: 200, body: null, nextCalled: false };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  localRequestGuard(req, res, () => { out.nextCalled = true; });
  return out;
}

const APP = { host: 'localhost:5173', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin', 'x-requested-with': 'portfolio-tracker' };

test('the app’s own requests pass, through the Vite proxy or directly', () => {
  assert.ok(run('GET', { host: 'localhost:5173', 'sec-fetch-site': 'same-origin' }).nextCalled);
  assert.ok(run('POST', APP).nextCalled);
  assert.ok(run('DELETE', { ...APP, host: '127.0.0.1:4000', 'sec-fetch-site': 'same-site' }).nextCalled);
});

test('local tools without Origin (curl) can read; writes still need the header', () => {
  assert.ok(run('GET', { host: 'localhost:4000' }).nextCalled);
  assert.ok(run('GET', { host: '[::1]:4000' }).nextCalled);
  assert.equal(run('POST', { host: 'localhost:4000' }).status, 403);
  assert.ok(run('POST', { host: 'localhost:4000', 'x-requested-with': 'portfolio-tracker' }).nextCalled);
});

test('DNS rebinding: a non-loopback Host is refused, even for reads', () => {
  const r = run('GET', { host: 'evil.example:4000', 'sec-fetch-site': 'same-origin' });
  assert.equal(r.status, 403);
  assert.equal(r.nextCalled, false);
  assert.equal(run('GET', { host: '172.30.1.4:4000' }).status, 403);
});

test('CSRF: cross-site requests and foreign origins are refused', () => {
  assert.equal(run('GET', { host: 'localhost:4000', 'sec-fetch-site': 'cross-site' }).status, 403);
  assert.equal(run('DELETE', { ...APP, origin: 'https://evil.example', 'sec-fetch-site': undefined }).status, 403);
  assert.equal(run('OPTIONS', { host: 'localhost:4000', origin: 'https://evil.example' }).status, 403);
  assert.equal(run('POST', { ...APP, origin: 'null' }).status, 403);
  // A plain form POST from an allowed-looking context but without the header.
  assert.equal(run('POST', { host: 'localhost:4000', origin: 'http://localhost:5173' }).status, 403);
});

test('safeHttpUrl keeps http(s) links and drops script/data/relative URLs', () => {
  assert.equal(safeHttpUrl('https://news.example/a?b=1'), 'https://news.example/a?b=1');
  assert.equal(safeHttpUrl('http://x.example/'), 'http://x.example/');
  for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,<script>', '/relative', 'not a url', '', null, 42]) {
    assert.equal(safeHttpUrl(bad), '', String(bad));
  }
});

test('runExclusive answers 409 while the same job is in flight', async () => {
  const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json() { return this; } });
  let release;
  const first = runExclusive('job', res(), () => new Promise(r => { release = r; }));
  const r2 = res();
  await runExclusive('job', r2, async () => assert.fail('must not run concurrently'));
  assert.equal(r2.code, 409);
  release();
  await first;
  let ran = false;
  await runExclusive('job', res(), async () => { ran = true; });
  assert.ok(ran, 'runs again once the first finished');
});
