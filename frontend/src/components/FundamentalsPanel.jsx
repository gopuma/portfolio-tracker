import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Uniform fundamental metrics for one stock: valuation multiples, per-share figures,
 * profitability and balance-sheet health.
 *
 * Every figure comes from the backend's single derivation over the company's own filings
 * (see fundamentalRatios.js), so the same formula applies to a US and a Korean listing
 * alike — Yahoo's ready-made ratios are blank for KRX names and would leave half a
 * portfolio empty. Ratios are unitless; per-share amounts are in the reporting currency.
 */

const fmtRatio = n => (n == null || isNaN(n) ? '–' : Number(n).toFixed(2));
const fmtPct = (n, d = 1) => (n == null || isNaN(n) ? '–' : `${(Number(n) * 100).toFixed(d)}%`);

// Per-share amounts: KRW figures are whole-won, USD-style ones need cents.
function fmtPerShare(n, ccy) {
  if (n == null || isNaN(n)) return '–';
  const d = ccy === 'KRW' || ccy === 'JPY' ? 0 : 2;
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

// Large absolute money in compact units, so a KRW trillion and a USD billion both read.
function fmtBig(n, ccy) {
  if (n == null || isNaN(n)) return '–';
  const v = Number(n), a = Math.abs(v);
  const [scale, suffix] = a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1, ''];
  return `${(v / scale).toLocaleString(undefined, { maximumFractionDigits: suffix ? 2 : 0 })}${suffix}${ccy ? ` ${ccy}` : ''}`;
}

// Why a multiple is blank, when it's blank for a reason worth showing.
const NA_REASON = {
  negative_earnings: 'n/m — loss',
  negative_book_value: 'n/m — negative equity',
};

function Cell({ label, value, title, color, muted }) {
  return (
    <div title={title}>
      <div className="metric-label">{label}</div>
      <div
        className={`metric ${color || ''}`}
        style={{ fontSize: 20, color: muted ? 'var(--text-dim)' : undefined }}
      >
        {value}
      </div>
    </div>
  );
}

// A multiple, or the reason it can't be formed (a negative P/E would otherwise sort
// as though the stock were cheap).
function MultipleCell({ label, value, na, title }) {
  const reason = na ? NA_REASON[na] : null;
  return (
    <Cell
      label={label}
      value={reason || fmtRatio(value)}
      muted={!!reason}
      title={reason ? `${title} — not meaningful: ${na.replace(/_/g, ' ')}` : title}
    />
  );
}

export default function FundamentalsPanel({ symbol }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null); setData(null);
    api.ratios(symbol)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol]);

  const ccy = data?.currency;
  const sign = v => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0 }}>
          Fundamentals
          {data?.available && (
            <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-dim)', fontSize: 13 }}>
              {' '}(TTM to {data.as_of}{ccy ? ` · ${ccy}` : ''})
            </span>
          )}
        </h2>
        {data?.available && data.price != null && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            Multiples at {fmtPerShare(data.price, ccy)} {ccy}
            {data.price_date ? ` (close ${data.price_date})` : ''}
          </span>
        )}
      </div>

      {loading ? (
        <div className="loading">Loading fundamentals…</div>
      ) : err ? (
        <div className="error">Failed to load: {err}</div>
      ) : !data?.available ? (
        <div className="loading">
          {data?.reason === 'no_statements'
            ? 'No financial statements for this instrument — ETFs and funds hold securities rather than running a business, so per-company metrics do not apply.'
            : data?.reason === 'insufficient_history'
              ? `Only ${data.quarters} quarter${data.quarters === 1 ? '' : 's'} of filings available — a trailing-twelve-month figure needs 4.`
              : 'Fundamentals unavailable for this instrument.'}
        </div>
      ) : (
        <>
          <SectionLabel>Valuation</SectionLabel>
          <div className="grid-4" style={{ rowGap: 16 }}>
            <MultipleCell label="PER" value={data.valuation.per} na={data.valuation.per_na}
              title="Price / trailing-twelve-month earnings per share" />
            <MultipleCell label="PBR" value={data.valuation.pbr} na={data.valuation.pbr_na}
              title="Price / book value per share" />
            <MultipleCell label="PSR" value={data.valuation.psr}
              title="Price / trailing-twelve-month revenue per share" />
            <MultipleCell label="PCR" value={data.valuation.pcr}
              title="Price / trailing-twelve-month operating cash flow per share" />
          </div>

          <SectionLabel>Per share ({ccy})</SectionLabel>
          <div className="grid-4" style={{ rowGap: 16 }}>
            <Cell label="EPS" value={fmtPerShare(data.per_share.eps, ccy)} color={sign(data.per_share.eps)}
              title="Trailing-twelve-month net income ÷ diluted shares. Derived rather than read from the filing, so it is present even where the reported figure is not." />
            <Cell label="BPS" value={fmtPerShare(data.per_share.bps, ccy)}
              title="Book value (total equity) ÷ diluted shares" />
            <Cell label="SPS" value={fmtPerShare(data.per_share.sps, ccy)}
              title="Trailing-twelve-month revenue ÷ diluted shares" />
            <Cell label="CFPS" value={fmtPerShare(data.per_share.cfps, ccy)}
              title="Trailing-twelve-month operating cash flow ÷ diluted shares" />
          </div>

          <SectionLabel>Profitability</SectionLabel>
          <div className="grid-4" style={{ rowGap: 16 }}>
            <Cell label="ROE" value={fmtPct(data.profitability.roe)} color={sign(data.profitability.roe)}
              title="Trailing-twelve-month net income ÷ average shareholders' equity over the same window" />
            <Cell label="ROA" value={fmtPct(data.profitability.roa)} color={sign(data.profitability.roa)}
              title="Trailing-twelve-month net income ÷ average total assets over the same window" />
            <Cell label="ROIC (pre-tax)" value={fmtPct(data.profitability.roic_pretax)} color={sign(data.profitability.roic_pretax)}
              title="Operating income ÷ invested capital (debt + equity − cash). Stated pre-tax because tax expense is not in our stored statements; a post-tax figure would need an assumed rate." />
            <Cell label="Operating margin" value={fmtPct(data.profitability.operating_margin)} color={sign(data.profitability.operating_margin)}
              title="Trailing-twelve-month operating income ÷ revenue" />
            <Cell label="Gross margin" value={fmtPct(data.profitability.gross_margin)}
              title="Trailing-twelve-month gross profit ÷ revenue" />
            <Cell label="Net margin" value={fmtPct(data.profitability.net_margin)} color={sign(data.profitability.net_margin)}
              title="Trailing-twelve-month net income ÷ revenue" />
            <Cell label="FCF margin" value={fmtPct(data.health.fcf_margin)} color={sign(data.health.fcf_margin)}
              title="Trailing-twelve-month free cash flow ÷ revenue" />
            <Cell label="Market cap" value={fmtBig(data.valuation.market_cap, ccy)}
              title="Latest close × diluted shares" />
          </div>

          <SectionLabel>Balance sheet</SectionLabel>
          <div className="grid-4" style={{ rowGap: 16 }}>
            <Cell label="Debt / Equity" value={fmtRatio(data.health.debt_to_equity)}
              title="Total debt ÷ shareholders' equity" />
            <Cell label="Equity ratio" value={fmtPct(data.health.equity_ratio)}
              title="Shareholders' equity ÷ total assets — the share of the balance sheet funded by owners" />
            <Cell label="Net debt" value={fmtBig(data.health.net_debt, ccy)}
              color={data.health.net_debt == null ? '' : data.health.net_debt > 0 ? 'down' : 'up'}
              title="Total debt − cash and short-term investments. Negative means net cash." />
            <Cell label="Revenue (TTM)" value={fmtBig(data.ttm.revenue, ccy)}
              title="Sum of the last four reported quarters" />
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 16 }}>
            Trailing twelve months, {data.ttm_start} → {data.as_of}, derived from the company's filings in {ccy}.
            Ratios are currency-neutral and comparable across markets; per-share amounts are in {ccy}.
            {data.pending_quarter && (
              <> The {data.pending_quarter} quarter has no statement data from our source yet, so it is excluded —
              every figure here comes from the same four quarters. Sites that fold a partial quarter into some
              metrics but not others may therefore show a different PER or EPS for this stock.</>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-dim)', margin: '20px 0 10px' }}>
      {children}
    </div>
  );
}
