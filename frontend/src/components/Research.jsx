import { useEffect, useRef, useState } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, Legend } from 'recharts';
import { api } from '../api.js';

// Compact money, e.g. 1_250_000_000 -> "1.25B".
function fmtC(n) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 2 });
}
function fmtPct(n, d = 1) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(d)}%`;
}
function fmtNum(n, d = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
const cls = n => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');
// 'YYYY-MM-DD' -> "Q1'26" (calendar-quarter label) or "'26" for annual.
function periodLabel(date, freq) {
  const [y, m] = (date || '').split('-').map(Number);
  if (!y) return date;
  if (freq === 'annual') return `'${String(y).slice(2)}`;
  return `Q${Math.ceil(m / 3)}'${String(y).slice(2)}`;
}
const field = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13 };

const CURRENCIES = ['native', 'USD', 'KRW'];
const TABS = [
  { key: 'income', label: 'Income' },
  { key: 'balance', label: 'Balance' },
  { key: 'cashflow', label: 'Cash Flow' },
];
// Rows per statement tab: [key, label, isMoney]. Derived rows (margins/YoY) are added separately.
const ROWS = {
  income: [
    ['revenue', 'Revenue'], ['cost_of_revenue', 'Cost of Revenue'], ['gross_profit', 'Gross Profit'],
    ['operating_income', 'Operating Income'], ['net_income', 'Net Income'],
  ],
  balance: [
    ['total_assets', 'Total Assets'], ['total_liabilities', 'Total Liabilities'], ['total_equity', 'Total Equity'],
    ['cash_sti', 'Cash & ST Invest.'], ['total_debt', 'Total Debt'],
  ],
  cashflow: [
    ['operating_cf', 'Operating Cash Flow'], ['capex', 'CapEx'], ['fcf', 'Free Cash Flow'],
  ],
};

export default function Research() {
  const [symbol, setSymbol] = useState(null);
  const [currency, setCurrency] = useState('native');
  const [freq, setFreq] = useState('quarterly');
  const [tab, setTab] = useState('income');
  const [commonSize, setCommonSize] = useState(false);
  const [showEst, setShowEst] = useState(true);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    setLoading(true); setErr(null);
    api.research(symbol, currency)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) { setErr(e.message); setData(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, currency]);

  return (
    <>
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Research</h2>
          <TickerSearch onPick={s => setSymbol(s)} current={symbol} />
        </div>
        {!symbol && <div className="loading" style={{ marginTop: 12 }}>Search a company or ticker to view its financial statements, ratios, and forward estimates.</div>}
      </div>

      {symbol && (
        loading ? <div className="loading">Loading {symbol} fundamentals…</div>
        : err ? <div className="error">Failed to load: {err}</div>
        : data ? <ResearchBody data={data} currency={currency} setCurrency={setCurrency}
                    freq={freq} setFreq={setFreq} tab={tab} setTab={setTab}
                    commonSize={commonSize} setCommonSize={setCommonSize} showEst={showEst} setShowEst={setShowEst} />
        : null
      )}
    </>
  );
}

function ResearchBody({ data, currency, setCurrency, freq, setFreq, tab, setTab, commonSize, setCommonSize, showEst, setShowEst }) {
  const ccy = data.display_currency || '';
  const periods = (freq === 'annual' ? data.statements.annual : data.statements.quarterly).slice(-8);
  // Forward consensus columns matching the current frequency (0q/+1q for Q, 0y/+1y for annual).
  const estLabels = freq === 'annual' ? ['0y', '+1y'] : ['0q', '+1q'];
  const est = (data.estimates?.consensus || []).filter(c => estLabels.includes(c.period_label));
  const v = data.valuation || {};
  const s = data.snapshot || {};

  return (
    <>
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>{data.symbol} <span style={{ fontWeight: 400, fontSize: 15, color: 'var(--text-dim)' }}>{data.display_name}</span></h2>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
              Reports in {data.reporting_currency || '–'}{ccy && ccy !== data.reporting_currency ? ` · shown in ${ccy}` : ''}
              {!data.fx_supported && <span style={{ color: 'var(--amber)' }}> · FX conversion unavailable for {data.reporting_currency}, showing native</span>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Currency</span>
            {CURRENCIES.map(c => (
              <button key={c} className={`btn ${currency === c ? '' : 'ghost'}`} onClick={() => setCurrency(c)}>{c === 'native' ? 'Native' : c}</button>
            ))}
          </div>
        </div>

        {/* Snapshot + valuation strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginTop: 14 }}>
          <Stat label="Market Cap" value={fmtC(s.market_cap)} />
          <Stat label="Revenue (TTM)" value={fmtC(s.revenue_ttm)} sub={ccy} />
          <Stat label="Gross Margin" value={fmtPct(s.gross_margin)} />
          <Stat label="Net Margin" value={fmtPct(s.profit_margin)} />
          <Stat label="Trailing P/E" value={fmtNum(v.trailing_pe, 1)} />
          <Stat label="Forward P/E" value={fmtNum(v.forward_pe, 1)} />
          <Stat label="P/S" value={fmtNum(v.ps, 1)} />
        </div>
      </div>

      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {TABS.map(t => (
              <button key={t.key} className={`btn ${tab === t.key ? '' : 'ghost'}`} onClick={() => setTab(t.key)}>{t.label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className={`btn ${freq === 'quarterly' ? '' : 'ghost'}`} onClick={() => setFreq('quarterly')}>Quarterly 8Q</button>
              <button className={`btn ${freq === 'annual' ? '' : 'ghost'}`} onClick={() => setFreq('annual')}>Annual 5Y</button>
            </div>
            <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={commonSize} onChange={e => setCommonSize(e.target.checked)} /> Common-size %
            </label>
            {tab === 'income' && (
              <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={showEst} onChange={e => setShowEst(e.target.checked)} /> Estimates
              </label>
            )}
          </div>
        </div>

        {periods.length === 0 ? (
          <div className="loading">No {freq} statement data available for this ticker.</div>
        ) : (
          <StatementTable tab={tab} periods={periods} est={tab === 'income' && showEst ? est : []} freq={freq} ccy={ccy} commonSize={commonSize} />
        )}

        {tab === 'income' && periods.length > 0 && (
          <IncomeChart periods={periods} est={showEst ? est : []} freq={freq} ccy={ccy} />
        )}

        {tab === 'income' && freq === 'quarterly' && (
          <ModelVsConsensus consensus={data.estimates?.consensus} model={data.estimates?.model} ccy={ccy} />
        )}
      </div>
    </>
  );
}

// The statement table: period columns (+ forward estimate columns for income), rows per tab,
// plus derived margin/YoY rows. Common-size divides each cell by revenue (or total assets).
function StatementTable({ tab, periods, est, freq, ccy, commonSize }) {
  const rows = ROWS[tab];
  const denomKey = tab === 'balance' ? 'total_assets' : 'revenue';
  const cell = (p, key) => {
    const val = p[key];
    if (commonSize) { const d = p[denomKey]; return d ? fmtPct(val / d) : '–'; }
    return fmtC(val);
  };
  // YoY on revenue/net income: compare to the period one year earlier (4 quarters / 1 year back).
  const lag = freq === 'annual' ? 1 : 4;
  const yoy = (i, key) => {
    const prev = periods[i - lag];
    if (!prev || !prev[key] || periods[i][key] == null) return null;
    return periods[i][key] / prev[key] - 1;
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', position: 'sticky', left: 0, background: 'var(--panel)' }}>
              {ccy && !commonSize ? `${ccy}` : ''}
            </th>
            {periods.map(p => <th key={p.fiscal_date} className="num">{periodLabel(p.fiscal_date, freq)}</th>)}
            {est.map(e => <th key={e.period_label} className="num" style={{ color: 'var(--accent)' }}>{periodLabel(e.period_end, freq)}e</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, label]) => (
            <tr key={key}>
              <td style={{ position: 'sticky', left: 0, background: 'var(--panel)' }}>{label}</td>
              {periods.map(p => <td key={p.fiscal_date} className="num">{cell(p, key)}</td>)}
              {est.map(e => (
                <td key={e.period_label} className="num" style={{ color: 'var(--accent)' }}>
                  {key === 'revenue' ? (commonSize ? '100%' : fmtC(e.revenue))
                    : key === 'net_income' ? (commonSize ? fmtPct(e.net_margin) : fmtC(e.net_income)) : '–'}
                </td>
              ))}
            </tr>
          ))}
          {/* Derived rows */}
          {tab === 'income' && (
            <>
              <DerivedRow label="Gross Margin" periods={periods} est={est} calc={p => p.revenue ? p.gross_profit / p.revenue : null} estCalc={() => null} pct />
              <DerivedRow label="Net Margin" periods={periods} est={est} calc={p => p.revenue ? p.net_income / p.revenue : null} estCalc={e => e.net_margin} pct />
              <DerivedRow label="Revenue YoY" periods={periods} est={est} calc={(p, i) => yoy(i, 'revenue')} estCalc={() => null} pct color />
              <DerivedRow label="EPS (diluted)" periods={periods} est={est} calc={p => p.eps_diluted} estCalc={e => e.eps} money />
            </>
          )}
        </tbody>
      </table>
      {est.length > 0 && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>Columns marked <span style={{ color: 'var(--accent)' }}>e</span> are analyst-consensus estimates.</div>}
    </div>
  );
}

function DerivedRow({ label, periods, est, calc, estCalc, pct, money, color }) {
  const fmt = pct ? (v => fmtPct(v)) : money ? (v => fmtNum(v)) : fmtC;
  return (
    <tr style={{ color: 'var(--text-dim)' }}>
      <td style={{ position: 'sticky', left: 0, background: 'var(--panel)', fontStyle: 'italic' }}>{label}</td>
      {periods.map((p, i) => {
        const val = calc(p, i);
        return <td key={p.fiscal_date} className={`num ${color ? cls(val) : ''}`}>{fmt(val)}</td>;
      })}
      {est.map(e => {
        const val = estCalc(e);
        return <td key={e.period_label} className={`num ${color ? cls(val) : ''}`} style={{ color: 'var(--accent)' }}>{val == null ? '–' : fmt(val)}</td>;
      })}
    </tr>
  );
}

// Revenue bars (actual solid, forward estimate hollow) + net-margin line.
function IncomeChart({ periods, est, freq, ccy }) {
  const rows = periods.map(p => ({
    name: periodLabel(p.fiscal_date, freq), revenue: p.revenue,
    margin: p.revenue ? (p.net_income / p.revenue) * 100 : null, est: false,
  }));
  for (const e of est) rows.push({
    name: `${periodLabel(e.period_end, freq)}e`, revenue: e.revenue,
    margin: e.net_margin != null ? e.net_margin * 100 : null, est: true,
  });
  return (
    <div style={{ width: '100%', height: 280, marginTop: 16 }}>
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
          <XAxis dataKey="name" stroke="#9aa0a6" fontSize={11} />
          <YAxis yAxisId="l" stroke="#9aa0a6" fontSize={11} width={52} tickFormatter={fmtC} />
          <YAxis yAxisId="r" orientation="right" stroke="#34d399" fontSize={11} width={40} tickFormatter={v => `${v.toFixed(0)}%`} />
          <Tooltip contentStyle={{ background: '#1a1f29', border: '1px solid #2d3441' }}
            formatter={(val, name) => name === 'Net margin' ? [`${Number(val).toFixed(1)}%`, name] : [`${fmtC(val)} ${ccy}`, name]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar yAxisId="l" dataKey="revenue" name={`Revenue (${ccy})`} radius={[2, 2, 0, 0]} maxBarSize={48}>
            {rows.map((r, i) => <Cell key={i} fill={r.est ? '#4a9eff66' : '#4a9eff'} stroke={r.est ? '#4a9eff' : 'none'} strokeDasharray={r.est ? '4 2' : '0'} />)}
          </Bar>
          <Line yAxisId="r" type="monotone" dataKey="margin" name="Net margin" stroke="#34d399" strokeWidth={2} dot={{ r: 2 }} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// Next-quarter consensus vs. the ML house model — a divergence read.
function ModelVsConsensus({ consensus, model, ccy }) {
  const c = (consensus || []).find(x => x.period_label === '0q');
  const m = (model || []).find(x => x.period_label === '0q');
  if (!m) return null; // sidecar down or not enough history → nothing to show
  const dRev = c?.revenue && m?.revenue ? m.revenue / c.revenue - 1 : null;
  const dEps = c?.eps && m?.eps ? m.eps / c.eps - 1 : null;
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.8 }}>
      <strong style={{ color: 'var(--text)' }}>Next quarter — consensus vs. model (ML)</strong>
      <div>Revenue: consensus <b style={{ color: 'var(--text)' }}>{fmtC(c?.revenue)} {ccy}</b> · model <b style={{ color: 'var(--text)' }}>{fmtC(m.revenue)}</b>
        {dRev != null && <span className={cls(dRev)}> ({dRev > 0 ? '+' : ''}{fmtPct(dRev)} vs consensus)</span>}</div>
      <div>EPS: consensus <b style={{ color: 'var(--text)' }}>{fmtNum(c?.eps)}</b> · model <b style={{ color: 'var(--text)' }}>{fmtNum(m.eps)}</b>
        {dEps != null && <span className={cls(dEps)}> ({dEps > 0 ? '+' : ''}{fmtPct(dEps)} vs consensus)</span>}</div>
      <div style={{ fontStyle: 'italic', marginTop: 4 }}>Model is a seasonal-naive house view (a divergence signal), not a consensus replacement.</div>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div>
      <div className="metric-label">{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}
        {sub && <span style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 400 }}> {sub}</span>}</div>
    </div>
  );
}

// Debounced company/ticker search (mirrors the holdings search) for picking a stock to research.
function TickerSearch({ onPick, current }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const activeRef = useRef(null);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.searchSymbols(q.trim())
        .then(r => { if (!cancelled) { setResults(r.results || []); setOpen(true); setHi(0); } })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [hi]);

  const pick = r => { onPick(r.symbol); setQ(''); setResults([]); setOpen(false); };
  const onKey = e => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[hi]) pick(results[hi]); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div style={{ position: 'relative', width: 'min(360px, 70vw)' }}>
      <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={current ? `${current} — search another…` : 'Search company or ticker…'}
        style={{ ...field, width: '100%' }} />
      {open && results.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 10, left: 0, right: 0, marginTop: 4, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, maxHeight: 280, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
          {results.map((r, i) => (
            <button key={r.symbol} type="button" ref={i === hi ? activeRef : null} onClick={() => pick(r)} onMouseEnter={() => setHi(i)}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 12, width: '100%', textAlign: 'left', background: i === hi ? 'var(--panel)' : 'transparent', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--text)', padding: '8px 10px', cursor: 'pointer' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-dim)' }}>{r.symbol} · {r.exchange}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
