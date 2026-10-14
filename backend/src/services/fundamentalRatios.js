/**
 * Uniform fundamental ratios (PER, PBR, EPS, ROE, …) derived from the stored financial
 * statements, so every stock is measured the same way.
 *
 * WHY DERIVE RATHER THAN READ YAHOO'S READY-MADE RATIOS
 * Yahoo's summaryDetail/defaultKeyStatistics carry trailingPE, priceToBook, trailingEps
 * for US listings but leave them empty for KRX ones — measured across this portfolio,
 * every Korean holding came back null. Passing those through would leave half the
 * holdings blank and make the other half incomparable (Yahoo's TTM cutoffs and share
 * counts differ from ours). Deriving everything from one source — the `fundamentals`
 * table this app already caches — gives the same formula for every symbol in every market.
 *
 * CONVENTIONS, applied identically to every symbol:
 *   - Flow items (revenue, net income, …) are TTM: the sum of the last 4 quarters.
 *     All 4 must be present, else the figure is null. A 3-quarter "TTM" would understate
 *     earnings and silently inflate every margin and return built on it.
 *   - Stock items (equity, assets, debt) are the latest quarter's balance.
 *   - Return denominators (ROE/ROA) use the AVERAGE of the opening and closing balance
 *     over the TTM window, which is the standard treatment: a flow numerator measured
 *     over a year against a point-in-time denominator overstates returns for a company
 *     whose balance sheet grew during it.
 *   - Per-share figures use the latest diluted share count for every metric, so EPS, BPS
 *     and the price multiples built on them stay mutually consistent.
 *   - EPS is derived (net income ÷ shares) rather than read from the reported
 *     `eps_diluted` column: Korean filings populate that column for only some quarters,
 *     so summing it yields null exactly where derivation succeeds.
 *
 * CURRENCY: ratios are computed in the company's NATIVE reporting currency and are
 * therefore unitless and FX-immune. Never feed FX-converted inputs in — price converts at
 * a spot rate and statements at a period-average rate, so mixing them corrupts the ratio
 * by the drift between the two. Per-share amounts (EPS/BPS) are returned in native
 * currency and labelled with it.
 */

const num = v => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

// Columns that make a row an actually-reported quarter. Yahoo emits a placeholder row for
// a quarter whose statements it doesn't carry yet, holding only a share count and
// sometimes an EPS — Amazon's June 2026 quarter looked exactly like this. Those two fields
// alone can't support revenue, margins or a balance sheet, so they don't count here.
//
// The trade-off this encodes: we use the last four quarters for which a FULL set exists,
// so PER, PBR, ROE and the margins all describe the same window. Yahoo's own trailingEps
// folds in the partial quarter, so on a fast-growing name its EPS can sit well above ours
// (AMZN: ~33% higher) while its PBR still reflects the older balance sheet. Matching that
// would mean mixing windows across metrics, which is exactly what this module exists to
// avoid; the pending quarter is surfaced instead so the date is visible rather than implied.
const SUBSTANCE_COLS = ['revenue', 'net_income', 'operating_income', 'total_equity', 'total_assets'];
const isReported = r => SUBSTANCE_COLS.some(c => num(r[c]) != null);

/** Sum of `key` over `rows`; null unless every row has the value. */
function sumAll(rows, key) {
  let total = 0;
  for (const r of rows) {
    const v = num(r[key]);
    if (v == null) return null;
    total += v;
  }
  return rows.length ? total : null;
}

/** Safe division: null unless both sides are numbers and the denominator is non-zero. */
const div = (a, b) => (a == null || b == null || b === 0 ? null : a / b);

/**
 * A negative denominator makes a multiple meaningless rather than merely large: a company
 * with negative earnings or negative book value produces a negative P/E or P/B that looks
 * like a cheap stock when sorted. Those are reported as null with a reason instead.
 */
const multiple = (price, perShare) =>
  price == null || perShare == null || perShare <= 0 ? null : price / perShare;

/**
 * @param {object[]} quarterly  Ascending by fiscal_date, native currency (as stored).
 * @param {object}   opts
 * @param {number}   opts.price          Current price, NATIVE currency.
 * @param {string}   opts.currency       Native reporting currency.
 * @param {number}   [opts.sharesOutstanding]  Fallback when statements omit share counts.
 * @returns {object} ratios, with `available:false` when the input can't support them.
 */
export function computeRatios(quarterly, { price, currency = null, sharesOutstanding = null } = {}) {
  const all = (quarterly || []).filter(r => r && r.fiscal_date)
    .slice().sort((a, b) => (a.fiscal_date < b.fiscal_date ? -1 : 1));

  // Drop trailing placeholder rows so the window covers the last four *reported* quarters.
  // Only trailing ones: a placeholder in the middle of the series is a genuine hole, and
  // splicing across it would silently pass off non-adjacent quarters as a TTM. Those still
  // fall to the all-or-null rule below, which is the honest answer.
  let end = all.length;
  while (end > 0 && !isReported(all[end - 1])) end--;
  const pendingQuarter = end < all.length ? all[end].fiscal_date : null;
  const rows = all.slice(0, end);

  // Funds and ETFs have no financial statements at all. That is a property of the
  // instrument, not a data gap, so it is reported distinctly from a failed fetch.
  if (rows.length === 0) {
    return { available: false, reason: 'no_statements', currency, as_of: null };
  }
  if (rows.length < 4) {
    return { available: false, reason: 'insufficient_history', quarters: rows.length, currency, as_of: null, pending_quarter: pendingQuarter };
  }

  const ttm = rows.slice(-4);
  const latest = ttm[ttm.length - 1];
  // Opening balance for the TTM average: the quarter before the window, when we have it.
  const opening = rows.length >= 5 ? rows[rows.length - 5] : ttm[0];

  const revenue = sumAll(ttm, 'revenue');
  const grossProfit = sumAll(ttm, 'gross_profit');
  const operatingIncome = sumAll(ttm, 'operating_income');
  const netIncome = sumAll(ttm, 'net_income');
  const operatingCf = sumAll(ttm, 'operating_cf');
  const fcf = sumAll(ttm, 'fcf');

  const equity = num(latest.total_equity);
  const assets = num(latest.total_assets);
  const liabilities = num(latest.total_liabilities);
  const debt = num(latest.total_debt);
  const cash = num(latest.cash_sti);
  const shares = num(latest.shares) ?? num(sharesOutstanding);

  const avgEquity = equity != null && num(opening.total_equity) != null
    ? (equity + num(opening.total_equity)) / 2 : equity;
  const avgAssets = assets != null && num(opening.total_assets) != null
    ? (assets + num(opening.total_assets)) / 2 : assets;

  const eps = div(netIncome, shares);        // TTM earnings per share
  const bps = div(equity, shares);           // book value per share
  const sps = div(revenue, shares);          // revenue per share
  const cfps = div(operatingCf, shares);     // operating cash flow per share
  const px = num(price);

  // Invested capital, pre-tax. We don't store tax expense, so a post-tax ROIC would need
  // an assumed rate; reporting the pre-tax figure keeps it derived rather than guessed.
  const investedCapital = debt != null && equity != null
    ? debt + equity - (cash ?? 0) : null;

  return {
    available: true,
    currency,
    as_of: latest.fiscal_date,
    ttm_start: ttm[0].fiscal_date,
    // A quarter Yahoo lists but hasn't populated yet — reported so the UI can say the
    // figures predate it rather than looking silently out of date.
    pending_quarter: pendingQuarter,
    price: px,
    shares,

    valuation: {
      per: multiple(px, eps),   // price / TTM EPS
      pbr: multiple(px, bps),   // price / book value per share
      psr: multiple(px, sps),   // price / TTM revenue per share
      pcr: multiple(px, cfps),  // price / TTM operating cash flow per share
      market_cap: px != null && shares != null ? px * shares : null,
      // Flagged so the UI can say "negative earnings" instead of showing an empty cell.
      per_na: eps != null && eps <= 0 ? 'negative_earnings' : null,
      pbr_na: bps != null && bps <= 0 ? 'negative_book_value' : null,
    },

    per_share: { eps, bps, sps, cfps },

    profitability: {
      roe: div(netIncome, avgEquity),
      roa: div(netIncome, avgAssets),
      roic_pretax: div(operatingIncome, investedCapital),
      gross_margin: div(grossProfit, revenue),
      operating_margin: div(operatingIncome, revenue),
      net_margin: div(netIncome, revenue),
    },

    health: {
      debt_to_equity: div(debt, equity),
      net_debt: debt != null ? debt - (cash ?? 0) : null,
      equity_ratio: div(equity, assets),
      fcf_margin: div(fcf, revenue),
    },

    ttm: { revenue, gross_profit: grossProfit, operating_income: operatingIncome, net_income: netIncome, operating_cf: operatingCf, fcf },
    balance: { total_equity: equity, total_assets: assets, total_liabilities: liabilities, total_debt: debt, cash_sti: cash },
  };
}
