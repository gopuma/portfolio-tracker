/**
 * Monte Carlo projection of a portfolio with spending, income and inflation.
 *
 * Month by month, on every path:
 *   1. At the start of each year, that year's inflation is drawn (normal, around the
 *      chosen rate), and under the percent-of-balance rule that year's spending is set.
 *   2. Spending is withdrawn and income added, both raised by inflation so far (they are
 *      entered in today's money). A balance that would go below zero is set to zero and
 *      the path counts as having run out.
 *   3. The balance earns that month's return.
 *
 * Returns are log-normal, matched to the chosen average annual return and volatility.
 * They are either drawn independently each month ('normal') or taken as 12-month blocks
 * of the portfolio's own history, recentred and rescaled to the chosen return and
 * volatility ('historical'), which keeps history's fat tails and runs of bad months.
 *
 * Everything is pure, so the same code runs in the worker and the tests.
 */

export const MIN_PATHS = 10000;
export const BLOCK_MONTHS = 12;
export const PERCENTILES = [0.05, 0.25, 0.5, 0.75, 0.95];

// Small, fast, seedable generator (mulberry32): the same seed gives the same paths, so
// changing one input shows the effect of that input, not of fresh random numbers.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normals(rand) {
  let spare = null;
  return () => {
    if (spare != null) { const z = spare; spare = null; return z; }
    let u = 0;
    while (u === 0) u = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * rand();
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

/**
 * Monthly log-return mean and sd for an average (arithmetic) annual return `mean` and an
 * annual volatility `vol`, so that a year's growth has expected value 1 + mean.
 */
export function monthlyLogParams(mean, vol) {
  const varLog = Math.log(1 + (vol * vol) / ((1 + mean) * (1 + mean)));
  return { m: (Math.log(1 + mean) - varLog / 2) / 12, s: Math.sqrt(varLog / 12) };
}

/**
 * Average annual return and volatility of a monthly return series, on the same basis as
 * monthlyLogParams (so feeding them back reproduces the history), plus its compound rate.
 */
export function historyStats(monthly) {
  const n = monthly.length;
  if (n < 2) return null;
  const logs = monthly.map(r => Math.log(1 + r));
  const m = logs.reduce((a, b) => a + b, 0) / n;
  const v = logs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1);
  const varLog = v * 12;
  const compound = Math.exp(12 * m) - 1;
  const mean = (1 + compound) * Math.exp(varLog / 2) - 1;
  const vol = (1 + mean) * Math.sqrt(Math.exp(varLog) - 1);
  return { mean, vol, compound, months: n };
}

/** Value-weighted monthly returns of several portfolios held together. */
export function combineHistory(series, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!series.length || total <= 0) return [];
  const n = Math.min(...series.map(s => s.length));
  const out = new Array(n).fill(0);
  series.forEach((s, j) => { for (let i = 0; i < n; i++) out[i] += (weights[j] / total) * s[i]; });
  return out;
}

// Value at quantile q of an ascending-sorted array.
function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function bands(values) {
  values.sort();
  const out = {};
  for (const q of PERCENTILES) out[`p${Math.round(q * 100)}`] = quantile(values, q);
  return out;
}

/**
 * Run the projection. Params:
 *   start            starting balance
 *   years            horizon in years
 *   paths            number of simulated paths (at least MIN_PATHS)
 *   seed             random seed
 *   model            'normal' | 'historical'
 *   mean, vol        average annual return and annual volatility (nominal, decimals)
 *   history          monthly returns, for the 'historical' model
 *   inflation        average annual inflation; inflationVol its year-to-year sd
 *   strategy         'fixed': spend `spending` a year in today's money, raised with
 *                    inflation; 'percent': spend `rate` of the balance at each year's start
 *   spending, rate
 *   income           income a year in today's money (pension), from year `incomeStart`
 *   cashShare        share of the balance held as cash, rebalanced monthly; the return
 *                    and volatility above then describe only the invested rest
 *   cashSpread       what cash earns above inflation (a savings account), per year
 *   otherShare       share of the balance earning a steady `otherRate` a year (assets
 *                    outside the portfolios, such as deposits), rebalanced monthly
 *
 * Returns per-year percentile bands of the balance in today's money (`real`) and in
 * future money (`nominal`), the share of paths run out by each year, the spending bands
 * under the percent rule, headline odds, and the most fixed spending that still lasts.
 */
export function simulate(p) {
  const t0 = Date.now();
  const N = Math.max(MIN_PATHS, Math.floor(p.paths || MIN_PATHS));
  const H = Math.max(1, Math.round(p.years));
  const months = H * 12;
  const rand = rng(p.seed ?? 1);
  const z = normals(rand);
  const { m, s } = monthlyLogParams(p.mean, p.vol);
  const incomeFrom = Math.max(0, Math.round((p.incomeStart || 0) * 12));
  const income = p.income || 0;
  const fixed = p.strategy !== 'percent';
  const cashShare = Math.min(1, Math.max(0, p.cashShare || 0));
  const cashMonthly = Math.pow(1 + (p.cashSpread || 0), 1 / 12);
  const otherShare = Math.min(1 - cashShare, Math.max(0, p.otherShare || 0));
  const otherMonthly = Math.pow(1 + (p.otherRate || 0), 1 / 12);
  const investedShare = 1 - cashShare - otherShare;

  // History, as log returns rescaled to the chosen mean and volatility.
  let hist = null;
  if (p.model === 'historical' && p.history && p.history.length >= BLOCK_MONTHS) {
    const logs = p.history.map(r => Math.log(1 + r));
    const hm = logs.reduce((a, b) => a + b, 0) / logs.length;
    const hs = Math.sqrt(logs.reduce((a, x) => a + (x - hm) ** 2, 0) / (logs.length - 1)) || 1;
    hist = Float64Array.from(logs, x => m + (x - hm) * (s / hs));
  }

  // Year-end balances per path, as columns by year, so each year sorts on its own.
  // Float32 keeps 100,000 paths × 60 years to a few tens of MB.
  const real = Array.from({ length: H + 1 }, () => new Float32Array(N));
  const nominal = Array.from({ length: H + 1 }, () => new Float32Array(N));
  const spendReal = fixed ? null : Array.from({ length: H }, () => new Float32Array(N));
  const ranOutYear = new Float64Array(N).fill(Infinity);
  // Most fixed spending each path could have afforded: lasting the whole horizon, and
  // also ending with at least the starting value in today's money.
  const lastsUpTo = new Float64Array(N);
  const keepsUpTo = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    let bal = p.start, cpi = 1, monthCpi = 1, yearSpend = 0;
    let out = false;
    // Balance = A − S·C for a fixed real spending S, tracked alongside for the solver.
    let A = p.start, C = 0, maxS = Infinity;
    let blockStart = 0;
    real[0][i] = p.start; nominal[0][i] = p.start;

    for (let t = 0; t < months; t++) {
      if (t % 12 === 0) {
        const infl = Math.max(-0.5, p.inflation + (p.inflationVol || 0) * z());
        monthCpi = Math.pow(1 + infl, 1 / 12);
        if (!fixed) {
          yearSpend = Math.max(0, bal) * (p.rate || 0);
          spendReal[t / 12][i] = yearSpend / cpi;
        }
      }
      if (hist && t % BLOCK_MONTHS === 0) blockStart = Math.floor(rand() * hist.length);

      const inc = t >= incomeFrom ? income : 0;
      const spend = fixed ? (p.spending || 0) * cpi : yearSpend;
      bal += (inc * cpi - spend) / 12;
      if (bal < 0) {
        bal = 0;
        if (!out) { out = true; ranOutYear[i] = t / 12; }
      }
      A += (inc * cpi) / 12;
      C += cpi / 12;
      if (A / C < maxS) maxS = A / C;

      const x = hist ? hist[(blockStart + (t % BLOCK_MONTHS)) % hist.length] : m + s * z();
      // Cash keeps pace with this path's inflation, plus its margin.
      const g = investedShare * Math.exp(x) + cashShare * monthCpi * cashMonthly + otherShare * otherMonthly;
      bal *= g; A *= g; C *= g;
      cpi *= monthCpi;

      if ((t + 1) % 12 === 0) {
        const y = (t + 1) / 12;
        nominal[y][i] = bal;
        real[y][i] = bal / cpi;
      }
    }
    lastsUpTo[i] = Math.max(0, maxS);
    keepsUpTo[i] = Math.max(0, Math.min(maxS, (A - p.start * cpi) / C));
  }

  const ranOutBy = [];
  for (let y = 0; y <= H; y++) {
    let k = 0;
    for (let i = 0; i < N; i++) if (ranOutYear[i] < y) k++;
    ranOutBy.push(k / N);
  }
  let neverOut = 0, kept = 0;
  for (let i = 0; i < N; i++) {
    if (ranOutYear[i] === Infinity) neverOut++;
    if (real[H][i] >= p.start) kept++;
  }
  const failures = Float64Array.from([...ranOutYear].filter(v => v !== Infinity)).sort();

  lastsUpTo.sort(); keepsUpTo.sort();
  // The spending that lasts in a share q of paths is the (1 − q) quantile of what each
  // path could afford.
  const safe = q => quantile(lastsUpTo, 1 - q);
  const keep = q => quantile(keepsUpTo, 1 - q);

  return {
    paths: N,
    years: H,
    strategy: fixed ? 'fixed' : 'percent',
    real: real.map(bands),
    nominal: nominal.map(bands),
    spending: spendReal ? spendReal.map(bands) : null,
    ranOutBy,
    success: neverOut / N,
    keepStart: kept / N,
    firstRunOut: failures.length ? { count: failures.length, p5: quantile(failures, 0.05), p50: quantile(failures, 0.5) } : null,
    safeSpending: { lasts90: safe(0.9), lasts95: safe(0.95), keeps90: keep(0.9), keeps75: keep(0.75) },
    ms: Date.now() - t0,
  };
}
