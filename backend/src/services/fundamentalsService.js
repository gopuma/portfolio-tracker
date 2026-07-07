/**
 * Fundamentals data source: financial statements and forward estimates from Yahoo.
 *
 * Statements come from `fundamentalsTimeSeries` (the modern endpoint — the old
 * incomeStatementHistory/balanceSheetHistory/cashflowStatementHistory modules were
 * deprecated and now return almost nothing). Estimates/valuation come from
 * `quoteSummary` (earningsTrend + financialData + summaryDetail + price).
 *
 * All figures are returned in the company's NATIVE reporting currency; FX conversion
 * to a common currency is applied at read time by the route (period-average rate).
 */
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// Fetch a bit more history than we display (8Q / 5Y) so the ML model has enough series.
const QUARTERLY_FROM = '2021-01-01'; // ~up to ~20 quarters where available
const ANNUAL_FROM = '2019-01-01';    // ~up to 7 fiscal years where available

const num = v => (v == null || (typeof v === 'number' && isNaN(v)) ? null : Number(v));
const isoDate = d => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

// Map one fundamentalsTimeSeries period object → our curated column set. Yahoo exposes
// many aliases per line item; we take the canonical one with sensible fallbacks.
function mapStatementRow(r) {
  const capex = num(r.capitalExpenditure);          // reported negative
  const opcf = num(r.operatingCashFlow);
  const fcf = num(r.freeCashFlow);
  return {
    fiscal_date: isoDate(r.date),
    revenue: num(r.totalRevenue ?? r.operatingRevenue),
    cost_of_revenue: num(r.costOfRevenue ?? r.reconciledCostOfRevenue),
    gross_profit: num(r.grossProfit),
    operating_income: num(r.operatingIncome ?? r.totalOperatingIncomeAsReported),
    net_income: num(r.netIncome ?? r.netIncomeCommonStockholders),
    eps_diluted: num(r.dilutedEPS),
    total_assets: num(r.totalAssets),
    total_liabilities: num(r.totalLiabilitiesNetMinorityInterest),
    total_equity: num(r.stockholdersEquity),
    cash_sti: num(r.cashCashEquivalentsAndShortTermInvestments ?? r.cashAndCashEquivalents),
    total_debt: num(r.totalDebt),
    operating_cf: opcf,
    capex,
    // Yahoo usually gives freeCashFlow directly; else derive (capex is negative).
    fcf: fcf ?? (opcf != null && capex != null ? opcf + capex : null),
    shares: num(r.dilutedAverageShares ?? r.shareIssued),
  };
}

/** Financial statements for a symbol: { currency, quarterly:[…], annual:[…] } (native currency). */
export async function fetchStatements(symbol) {
  const load = async (type, period1) => {
    try {
      const r = await yahooFinance.fundamentalsTimeSeries(
        symbol, { period1, type, module: 'all' }, { validateResult: false });
      const rows = (Array.isArray(r) ? r : []).filter(x => x && x.date);
      return rows.map(mapStatementRow).sort((a, b) => (a.fiscal_date < b.fiscal_date ? -1 : 1));
    } catch {
      return [];
    }
  };
  const [quarterly, annual] = await Promise.all([
    load('quarterly', QUARTERLY_FROM),
    load('annual', ANNUAL_FROM),
  ]);
  return { quarterly, annual };
}

/**
 * Forward estimates + valuation + a TTM snapshot for a symbol. Consensus estimates come
 * from earningsTrend (labels 0q/+1q/0y/+1y). Returns native reporting currency.
 */
export async function fetchEstimates(symbol) {
  const q = await yahooFinance.quoteSummary(
    symbol,
    { modules: ['earningsTrend', 'financialData', 'summaryDetail', 'defaultKeyStatistics', 'price'] },
    { validateResult: false }
  );

  const fd = q.financialData || {};
  const sd = q.summaryDetail || {};
  const ks = q.defaultKeyStatistics || {};
  const price = q.price || {};
  const currency = fd.financialCurrency || price.currency || null;

  const WANT = new Set(['0q', '+1q', '0y', '+1y']);
  const consensus = (q.earningsTrend?.trend || [])
    .filter(t => WANT.has(t.period))
    .map(t => ({
      period_label: t.period,
      period_end: t.endDate ? isoDate(t.endDate) : null,
      revenue_avg: num(t.revenueEstimate?.avg),
      eps_avg: num(t.earningsEstimate?.avg),
      num_analysts: num(t.revenueEstimate?.numberOfAnalysts ?? t.earningsEstimate?.numberOfAnalysts),
    }));

  return {
    currency,
    consensus,
    valuation: {
      trailing_pe: num(sd.trailingPE ?? ks.trailingEps),
      forward_pe: num(sd.forwardPE ?? ks.forwardPE),
      ps: num(sd.priceToSalesTrailing12Months),
      market_cap: num(price.marketCap ?? sd.marketCap),
    },
    snapshot: {
      revenue_ttm: num(fd.totalRevenue),
      gross_margin: num(fd.grossMargins),
      operating_margin: num(fd.operatingMargins),
      profit_margin: num(fd.profitMargins),
      target_mean_price: num(fd.targetMeanPrice),
    },
    shares: num(ks.sharesOutstanding ?? price.sharesOutstanding),
    latest_price: num(price.regularMarketPrice),
  };
}
