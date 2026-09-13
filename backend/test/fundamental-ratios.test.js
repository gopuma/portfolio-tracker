/**
 * Fundamental ratio math, checked against hand-computed values so the definitions
 * can't drift silently — these figures drive investment decisions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRatios } from '../src/services/fundamentalRatios.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// 5 quarters so the TTM window (last 4) has a true opening balance in the 5th-from-last.
// Net income 4×25 = 100 TTM; revenue 4×500 = 2000; shares 50 → EPS 2.
// Equity 900→1100 over the window (avg 1000); assets 1800→2200 (avg 2000).
const rows = [
  { fiscal_date: '2024-09-30', revenue: 480, gross_profit: 240, operating_income: 120, net_income: 24, total_equity: 900,  total_assets: 1800, total_liabilities: 900,  total_debt: 400, cash_sti: 100, operating_cf: 130, fcf: 90,  shares: 50 },
  { fiscal_date: '2024-12-31', revenue: 500, gross_profit: 250, operating_income: 125, net_income: 25, total_equity: 950,  total_assets: 1900, total_liabilities: 950,  total_debt: 400, cash_sti: 110, operating_cf: 135, fcf: 95,  shares: 50 },
  { fiscal_date: '2025-03-31', revenue: 500, gross_profit: 250, operating_income: 125, net_income: 25, total_equity: 1000, total_assets: 2000, total_liabilities: 1000, total_debt: 400, cash_sti: 120, operating_cf: 135, fcf: 95,  shares: 50 },
  { fiscal_date: '2025-06-30', revenue: 500, gross_profit: 250, operating_income: 125, net_income: 25, total_equity: 1050, total_assets: 2100, total_liabilities: 1050, total_debt: 400, cash_sti: 130, operating_cf: 135, fcf: 95,  shares: 50 },
  { fiscal_date: '2025-09-30', revenue: 500, gross_profit: 250, operating_income: 125, net_income: 25, total_equity: 1100, total_assets: 2200, total_liabilities: 1100, total_debt: 400, cash_sti: 140, operating_cf: 135, fcf: 95,  shares: 50 },
];

test('TTM flows sum the last four quarters only', () => {
  const r = computeRatios(rows, { price: 40 });
  assert.equal(r.ttm.net_income, 100);   // 25×4 — the 24 in the 5th-from-last is excluded
  assert.equal(r.ttm.revenue, 2000);
  assert.equal(r.as_of, '2025-09-30');
  assert.equal(r.ttm_start, '2024-12-31');
});

test('EPS, BPS and the multiples built on them', () => {
  const r = computeRatios(rows, { price: 40 });
  assert.equal(r.per_share.eps, 2);          // 100 / 50
  assert.equal(r.per_share.bps, 22);         // 1100 / 50
  assert.equal(r.valuation.per, 20);         // 40 / 2
  assert.ok(close(r.valuation.pbr, 40 / 22));
  assert.equal(r.valuation.market_cap, 2000); // 40 × 50
});

test('ROE and ROA use the average balance over the TTM window', () => {
  const r = computeRatios(rows, { price: 40 });
  // The opening balance is the quarter BEFORE the window (2024-09-30, equity 900),
  // not the window's first quarter — so the average spans the full 12 months:
  // (900 + 1100) / 2 = 1000, and assets (1800 + 2200) / 2 = 2000.
  assert.ok(close(r.profitability.roe, 100 / 1000));
  assert.ok(close(r.profitability.roa, 100 / 2000));
  // Using the closing balance instead would understate ROE — guard against that regression.
  assert.ok(r.profitability.roe > 100 / 1100);
});

test('PBR = PER x ROE holds, so the three are mutually consistent', () => {
  // The identity is exact only when ROE uses the same equity as BPS, so recompute it
  // on the closing balance the way the identity assumes.
  const r = computeRatios(rows, { price: 40 });
  const roeClosing = r.ttm.net_income / r.balance.total_equity;
  assert.ok(close(r.valuation.pbr, r.valuation.per * roeClosing, 1e-12));
});

test('margins and capital efficiency', () => {
  const r = computeRatios(rows, { price: 40 });
  assert.ok(close(r.profitability.net_margin, 100 / 2000));
  assert.ok(close(r.profitability.operating_margin, 500 / 2000));
  assert.ok(close(r.profitability.gross_margin, 1000 / 2000));
  // invested capital = debt 400 + equity 1100 − cash 140 = 1360
  assert.ok(close(r.profitability.roic_pretax, 500 / 1360));
  assert.equal(r.health.debt_to_equity, 400 / 1100);
  assert.equal(r.health.net_debt, 260);
});

test('a missing quarter yields null rather than a short TTM', () => {
  // A 3-of-4 sum would understate earnings and inflate every margin built on it.
  const gapped = rows.map((r, i) => (i === 4 ? { ...r, net_income: null } : r));
  const r = computeRatios(gapped, { price: 40 });
  assert.equal(r.ttm.net_income, null);
  assert.equal(r.per_share.eps, null);
  assert.equal(r.valuation.per, null);
  assert.equal(r.ttm.revenue, 2000); // unaffected columns still compute
});

test('negative earnings and negative book value report a reason, not a misleading multiple', () => {
  const lossy = rows.map(r => ({ ...r, net_income: -25 }));
  const r = computeRatios(lossy, { price: 40 });
  assert.equal(r.per_share.eps, -2);
  assert.equal(r.valuation.per, null, 'a negative P/E would sort as if it were cheap');
  assert.equal(r.valuation.per_na, 'negative_earnings');

  const insolvent = rows.map(r => ({ ...r, total_equity: -100 }));
  const r2 = computeRatios(insolvent, { price: 40 });
  assert.equal(r2.valuation.pbr, null);
  assert.equal(r2.valuation.pbr_na, 'negative_book_value');
});

test('EPS is derived, so it survives the gaps in reported eps_diluted', () => {
  // Korean filings populate eps_diluted for only some quarters; deriving from
  // net income ÷ shares is what makes KRX and US listings comparable.
  const partial = rows.map((r, i) => ({ ...r, eps_diluted: i % 2 ? null : 0.5 }));
  const r = computeRatios(partial, { price: 40 });
  assert.equal(r.per_share.eps, 2);
});

test('a trailing placeholder quarter is skipped, not counted as reported', () => {
  // Yahoo lists the current quarter before it has the financials, carrying only a share
  // count and sometimes an EPS estimate (observed on AMZN's June 2026 quarter). Treating
  // that as a reported quarter drags it into the TTM window and nulls every sum.
  const withStub = [...rows, {
    fiscal_date: '2025-12-31', revenue: null, gross_profit: null, operating_income: null,
    net_income: null, total_equity: null, total_assets: null, total_liabilities: null,
    total_debt: null, cash_sti: null, operating_cf: null, fcf: null,
    eps_diluted: 0.4, shares: 51,
  }];
  const r = computeRatios(withStub, { price: 40 });
  assert.equal(r.available, true);
  assert.equal(r.as_of, '2025-09-30', 'window should end at the last reported quarter');
  assert.equal(r.pending_quarter, '2025-12-31');
  assert.equal(r.ttm.net_income, 100);
  assert.equal(r.per_share.eps, 2);
  assert.equal(r.valuation.per, 20);
  assert.equal(r.balance.total_equity, 1100, 'balance sheet comes from the last reported quarter');
});

test('several trailing placeholders are all skipped', () => {
  const stub = d => ({ fiscal_date: d, revenue: null, net_income: null, total_equity: null, total_assets: null, operating_income: null, shares: 51 });
  const r = computeRatios([...rows, stub('2025-12-31'), stub('2026-03-31')], { price: 40 });
  assert.equal(r.as_of, '2025-09-30');
  assert.equal(r.pending_quarter, '2025-12-31', 'reports the first pending quarter');
  assert.equal(r.ttm.net_income, 100);
});

test('a placeholder mid-series stays null rather than splicing non-adjacent quarters', () => {
  // Dropping a hole in the middle would pass off Q1+Q2+Q4+Q5 as a twelve-month figure.
  const holed = rows.map((r, i) => (i === 3
    ? { fiscal_date: r.fiscal_date, revenue: null, net_income: null, total_equity: null, total_assets: null, operating_income: null, shares: 50 }
    : r));
  const r = computeRatios(holed, { price: 40 });
  assert.equal(r.available, true);
  assert.equal(r.ttm.net_income, null);
  assert.equal(r.valuation.per, null);
  assert.equal(r.pending_quarter, null, 'a mid-series hole is not a pending quarter');
});

test('a row with only shares and EPS does not count as reported', () => {
  // EPS and shares alone are not a filing — guard the substance test against widening.
  const onlyPerShare = rows.slice(0, 4).concat([
    { fiscal_date: '2025-12-31', eps_diluted: 0.5, shares: 50 },
  ]);
  const r = computeRatios(onlyPerShare, { price: 40 });
  assert.equal(r.as_of, '2025-06-30');
  assert.equal(r.pending_quarter, '2025-12-31');
});

test('ETFs and short histories are distinguished from failures', () => {
  assert.deepEqual(
    { available: computeRatios([], { price: 10 }).available, reason: computeRatios([], { price: 10 }).reason },
    { available: false, reason: 'no_statements' }
  );
  const short = computeRatios(rows.slice(0, 2), { price: 10 });
  assert.equal(short.available, false);
  assert.equal(short.reason, 'insufficient_history');
  assert.equal(short.quarters, 2);
});

test('no price still yields the fundamentals, just no multiples', () => {
  const r = computeRatios(rows, { price: null });
  assert.equal(r.valuation.per, null);
  assert.equal(r.per_share.eps, 2);            // statement-only figures unaffected
  assert.ok(close(r.profitability.roe, 100 / 1000));
});

test('rows in any order are sorted before the TTM window is taken', () => {
  const shuffled = [rows[3], rows[0], rows[4], rows[2], rows[1]];
  const r = computeRatios(shuffled, { price: 40 });
  assert.equal(r.as_of, '2025-09-30');
  assert.equal(r.ttm.net_income, 100);
});

test('falls back to an external share count when statements omit one', () => {
  const noShares = rows.map(r => ({ ...r, shares: null }));
  const r = computeRatios(noShares, { price: 40, sharesOutstanding: 50 });
  assert.equal(r.per_share.eps, 2);
  assert.equal(r.valuation.per, 20);
});
