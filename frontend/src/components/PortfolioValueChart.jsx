import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList } from 'recharts';
import { api } from '../api.js';

function fmtMoney(n, ccy, d = 0) {
  if (n == null || isNaN(n)) return '–';
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: d })} ${ccy || ''}`.trim();
}
// Compact labels: 1_250_000 -> "1.3M".
function fmtCompact(n) {
  if (n == null || isNaN(n)) return '';
  return Number(n).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
}
function fmtPct(n, d = 1) {
  if (n == null || isNaN(n)) return '';
  return `${(Number(n) * 100).toFixed(d)}%`;
}
// 'YYYY-MM' -> "Jan '24". Built as local time so the month doesn't slip.
function fmtMonth(ym) {
  const [y, m] = (ym || '').split('-');
  if (!y || !m) return ym;
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
// 'YYYY-MM-DD' -> "Jun 29". Built as local time so the day doesn't slip.
function fmtDay(ymd) {
  const [y, m, d] = (ymd || '').split('-');
  if (!y || !m || !d) return ymd;
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// Sortable label of a point regardless of granularity (daily 'date' or monthly 'month').
const pointTs = p => p.date || `${p.month}-01`;
// 'YYYY-MM-DD' minus n calendar months, returned as 'YYYY-MM-DD'.
function minusMonths(ymd, n) {
  const [y, m, d] = (ymd || '').split('-').map(Number);
  const dt = new Date(y, (m - 1) - n, d || 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// Cash series carry the reserved symbol CASH:<CCY>; show them as "Cash (USD)".
const prettySym = s => (typeof s === 'string' && s.startsWith('CASH:') ? `Cash (${s.slice(5)})` : s);

const GREEN = '#34d399';
const RED = '#f87171';
const DIM = '#9aa0a6';
// Distinct stack colors; cycles if a portfolio has more holdings than colors.
const PALETTE = [
  '#4a9eff', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee', '#fb923c', '#f472b6',
  '#60a5fa', '#4ade80', '#facc15', '#fca5a5', '#c084fc', '#67e8f9', '#fdba74', '#f9a8d4',
  '#38bdf8', '#86efac', '#fde047', '#e879f9', '#2dd4bf', '#fbbf24', '#93c5fd', '#bef264',
];
const colorAt = i => PALETTE[i % PALETTE.length];

// Trailing-window presets (in months). `months: null` = show all available months.
const PRESETS = [
  { label: '6M', months: 6 },
  { label: '1Y', months: 12 },
  { label: '3Y', months: 36 },
  { label: 'All', months: null },
];

const inputStyle = {
  width: 72,
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '6px 8px',
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
};

// Tooltip: per-stock breakdown for the hovered period, plus total and period-over-period
// change. `hoverKey` bolds the actively-hovered stock's row. `daily` switches the label.
function ChartTooltip({ active, payload, ccy, symbols, hoverKey, daily }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const label = daily ? fmtDay(row.date) : fmtMonth(row.month);
  const deltaSuffix = daily ? 'DoD' : 'MoM';
  const meta = new Map(symbols.map(s => [s.key, s.symbol]));
  const segs = payload
    .filter(p => p.value != null && p.value > 0)
    .map(p => ({ key: p.dataKey, symbol: meta.get(p.dataKey) || p.dataKey, value: p.value, color: p.color }))
    .sort((a, b) => b.value - a.value);
  const momColor = row.mom == null ? DIM : row.mom > 0 ? GREEN : row.mom < 0 ? RED : DIM;
  return (
    <div style={{ background: '#1a1f29', border: '1px solid #2d3441', borderRadius: 6, padding: '8px 10px', fontSize: 12, maxHeight: 320, overflowY: 'auto' }}>
      <div style={{ color: DIM, marginBottom: 4 }}>{label}</div>
      <div style={{ color: '#e6e6e6', fontWeight: 600, marginBottom: 2 }}>Total {fmtMoney(row.total, ccy)}</div>
      {row.mom != null && (
        <div style={{ color: momColor, marginBottom: 6 }}>
          {row.mom > 0 ? '▲' : row.mom < 0 ? '▼' : ''} {fmtMoney(Math.abs(row.mom), ccy)}
          {row.momPct != null ? ` (${fmtPct(Math.abs(row.momPct))})` : ''} {deltaSuffix}
        </div>
      )}
      {segs.map(s => {
        const on = hoverKey === s.key;
        return (
          <div key={s.symbol} style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.5, opacity: hoverKey && !on ? 0.5 : 1 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ color: '#cbd2da', flex: 1, fontWeight: on ? 700 : 400 }}>{prettySym(s.symbol)}</span>
            <span style={{ color: '#e6e6e6', fontWeight: on ? 700 : 400 }}>{fmtMoney(s.value, ccy)}</span>
          </div>
        );
      })}
    </div>
  );
}

// Label drawn above the top of each stacked bar: the period's total value with its
// period-over-period change beneath (DoD in daily view, MoM in monthly). Attached to
// the top series so y is the stack top. Bars too narrow to fit legible text are skipped.
function makeTotalLabel(data) {
  return function TotalLabel({ x, y, width, index }) {
    const d = data[index];
    if (!d || x == null || y == null) return null;
    if (width != null && width < 12) return null;
    const cx = x + width / 2;
    let momText = '';
    let momColor = DIM;
    if (d.mom != null) {
      momColor = d.mom > 0 ? GREEN : d.mom < 0 ? RED : DIM;
      const arrow = d.mom > 0 ? '▲' : d.mom < 0 ? '▼' : '';
      momText = `${arrow} ${d.momPct != null ? fmtPct(Math.abs(d.momPct)) : fmtCompact(Math.abs(d.mom))}`;
    }
    return (
      <g>
        <text x={cx} y={y - 16} textAnchor="middle" fontSize={11} fontWeight={600} fill="#e6e6e6">{fmtCompact(d.total)}</text>
        {momText && <text x={cx} y={y - 4} textAnchor="middle" fontSize={10} fill={momColor}>{momText}</text>}
      </g>
    );
  };
}

// Monthly AVERAGE total asset value, stacked by stock. The backend reconstructs the
// holdings you actually held each month from the holding change log and averages their
// value across the month's trading days — so this is your real month-over-month record,
// updating automatically as you edit holdings. `reloadKey` changing forces a refetch
// (e.g. right after a holding is added, edited, or removed).
export default function PortfolioValueChart({ portfolioId, base, reloadKey }) {
  const [resp, setResp] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  // Stock currently hovered (in the chart or legend); highlights it everywhere.
  const [hoverKey, setHoverKey] = useState(null);
  // Trailing window in months to display (null = all available).
  const [rangeMonths, setRangeMonths] = useState(null);
  const [draft, setDraft] = useState('');
  // 'monthly' = each bar is the month's average; 'daily' = each bar is a day's close.
  const [granularity, setGranularity] = useState('monthly');
  const daily = granularity === 'daily';

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!n || n < 1) return;
    setRangeMonths(n);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setHoverKey(null);
    api.portfolioValueHistory(portfolioId, granularity)
      .then(d => { if (!cancelled) setResp(d); })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [portfolioId, reloadKey, granularity]);

  const ccy = resp?.base_currency || base;
  const symbols = resp?.symbols || [];
  // Attach period-over-period change (absolute and %) to each point for label/tooltip.
  const data = useMemo(() => {
    const pts = resp?.points || [];
    return pts.map((p, i) => {
      const prev = i > 0 ? pts[i - 1].total : null;
      const mom = prev != null ? p.total - prev : null;
      const momPct = prev != null && prev !== 0 ? (p.total - prev) / prev : null;
      return { ...p, mom, momPct };
    });
  }, [resp]);

  // Trailing window for display: keep points within `rangeMonths` calendar months of the
  // latest one (works for both daily and monthly). The change on each point is already
  // relative to its true previous point (computed on the full series), so this is safe.
  const visible = useMemo(() => {
    if (rangeMonths == null || data.length === 0) return data;
    const cutoff = minusMonths(pointTs(data.at(-1)), rangeMonths);
    return data.filter(p => pointTs(p) > cutoff);
  }, [data, rangeMonths]);

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: '0 0 4px' }}>{daily ? 'Daily Close Trend' : 'Monthly Average Asset Value'}</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {PRESETS.map(p => (
            <button
              key={p.label}
              className={`btn ${rangeMonths === p.months ? '' : 'ghost'}`}
              onClick={() => { setRangeMonths(p.months); setDraft(p.months == null ? '' : String(p.months)); }}
            >
              {p.label}
            </button>
          ))}
          <input
            type="number" min={1} value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') applyDraft(); }}
            placeholder="#"
            style={inputStyle}
          />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>months</span>
          <button className="btn" onClick={applyDraft}>Apply</button>
          {/* Toggle daily ↔ monthly. Label names the view you'll switch TO. */}
          <button
            className="btn"
            style={{ marginLeft: 4 }}
            onClick={() => setGranularity(g => (g === 'daily' ? 'monthly' : 'daily'))}
            title={daily ? 'Switch to the monthly-average view' : 'Switch to the daily-close view'}
          >
            {daily ? 'Monthly view' : 'Daily view'}
          </button>
        </div>
      </div>
      {daily ? (
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Each bar is your portfolio's total value at that <strong style={{ color: 'var(--text)' }}>trading day's close</strong>
          {' '}(in {ccy}), stacked by stock — the holdings you actually held that day valued at its closing prices. The figure on top
          is that day's total, with its day-over-day change beneath. Hover any bar for the per-stock breakdown. Switch back to{' '}
          <strong style={{ color: 'var(--text)' }}>Monthly view</strong> for each month's average.
        </p>
      ) : (
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Each bar is your portfolio's <strong style={{ color: 'var(--text)' }}>average</strong> total value across that month —
          the holdings you actually held then, valued at every business day's close (in {ccy}) and averaged, stacked by stock. The
          figure on top is the month's average, with its month-over-month change beneath. Switch to{' '}
          <strong style={{ color: 'var(--text)' }}>Daily view</strong> to see each day's closing total.
        </p>
      )}
      {loading ? (
        <div className="loading">Loading {daily ? 'daily' : 'monthly'} value…</div>
      ) : err ? (
        <div className="error">Failed to load: {err}</div>
      ) : data.length === 0 ? (
        <div className="loading">Not enough price history yet to chart {daily ? 'daily' : 'monthly'} value.</div>
      ) : (
        <>
          <div style={{ width: '100%', height: 340 }}>
            <ResponsiveContainer>
              <BarChart data={visible} margin={{ top: 28, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
                <XAxis dataKey={daily ? 'date' : 'month'} tickFormatter={daily ? fmtDay : fmtMonth} stroke="#9aa0a6" fontSize={11} minTickGap={20} />
                <YAxis
                  stroke="#9aa0a6" fontSize={11} width={52} tickFormatter={fmtCompact}
                  // Headroom so the on-bar total labels aren't clipped.
                  domain={[0, max => (max > 0 ? max * 1.18 : 1)]}
                />
                <Tooltip cursor={false} content={<ChartTooltip ccy={ccy} symbols={symbols} hoverKey={hoverKey} daily={daily} />} />
                {symbols.map((s, i) => {
                  const isTop = i === symbols.length - 1;
                  const dim = hoverKey && hoverKey !== s.key;
                  return (
                    <Bar
                      key={s.key} dataKey={s.key} name={s.symbol} stackId="v"
                      fill={colorAt(i)} maxBarSize={72} fillOpacity={dim ? 0.25 : 1}
                      radius={isTop ? [2, 2, 0, 0] : [0, 0, 0, 0]}
                      onMouseEnter={() => setHoverKey(s.key)}
                      onMouseLeave={() => setHoverKey(null)}
                    >
                      {/* On-bar total value + period-over-period % change (DoD daily, MoM monthly). */}
                      {isTop && <LabelList content={makeTotalLabel(visible)} />}
                    </Bar>
                  );
                })}
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Scrollable, interactive legend. Hovering an item highlights that stock's
              segments in the chart (and vice-versa) via the shared hoverKey. */}
          <div
            style={{
              display: 'flex', flexWrap: 'wrap', gap: '4px 14px',
              maxHeight: 92, overflowY: 'auto', marginTop: 10, paddingTop: 8,
              borderTop: '1px solid var(--border)',
            }}
          >
            {symbols.map((s, i) => {
              const on = hoverKey === s.key;
              const dim = hoverKey && !on;
              return (
                <div
                  key={s.key}
                  onMouseEnter={() => setHoverKey(s.key)}
                  onMouseLeave={() => setHoverKey(null)}
                  title={s.name || s.symbol}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'default',
                    fontWeight: on ? 700 : 400, opacity: dim ? 0.45 : 1,
                  }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: colorAt(i), flexShrink: 0 }} />
                  <span style={{ color: 'var(--text)' }}>{prettySym(s.symbol)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
