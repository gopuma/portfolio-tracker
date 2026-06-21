import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, LabelList } from 'recharts';
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

// Tooltip: per-stock breakdown for the hovered month, plus total and MoM change.
function ChartTooltip({ active, payload, ccy, symbols }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const labelBy = new Map(symbols.map(s => [s.key, s.symbol]));
  const segs = payload
    .filter(p => p.value != null && p.value > 0)
    .map(p => ({ symbol: labelBy.get(p.dataKey) || p.dataKey, value: p.value, color: p.color }))
    .sort((a, b) => b.value - a.value);
  const momColor = row.mom == null ? DIM : row.mom > 0 ? GREEN : row.mom < 0 ? RED : DIM;
  return (
    <div style={{ background: '#1a1f29', border: '1px solid #2d3441', borderRadius: 6, padding: '8px 10px', fontSize: 12, maxHeight: 320, overflowY: 'auto' }}>
      <div style={{ color: DIM, marginBottom: 4 }}>{fmtMonth(row.month)}</div>
      <div style={{ color: '#e6e6e6', fontWeight: 600, marginBottom: 2 }}>Total {fmtMoney(row.total, ccy)}</div>
      {row.mom != null && (
        <div style={{ color: momColor, marginBottom: 6 }}>
          {row.mom > 0 ? '▲' : row.mom < 0 ? '▼' : ''} {fmtMoney(Math.abs(row.mom), ccy)}
          {row.momPct != null ? ` (${fmtPct(Math.abs(row.momPct))})` : ''} MoM
        </div>
      )}
      {segs.map(s => (
        <div key={s.symbol} style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.5 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, flexShrink: 0 }} />
          <span style={{ color: '#cbd2da', flex: 1 }}>{s.symbol}</span>
          <span style={{ color: '#e6e6e6' }}>{fmtMoney(s.value, ccy)}</span>
        </div>
      ))}
    </div>
  );
}

// Label drawn above the top of each stacked bar: the month's total value with its
// month-over-month change beneath. Attached to the top series so y is the stack top.
function makeTotalLabel(data) {
  return function TotalLabel({ x, y, width, index }) {
    const d = data[index];
    if (!d || x == null || y == null) return null;
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

// Monthly total asset value of the portfolio's current holdings, valued at historical
// prices and stacked by stock. Each bar is one month's total in the base currency.
export default function PortfolioValueChart({ portfolioId, base }) {
  const [resp, setResp] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.portfolioValueHistory(portfolioId)
      .then(d => { if (!cancelled) setResp(d); })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [portfolioId]);

  const ccy = resp?.base_currency || base;
  const symbols = resp?.symbols || [];
  // Attach month-over-month change (absolute and %) to each point for label/tooltip.
  const data = useMemo(() => {
    const pts = resp?.points || [];
    return pts.map((p, i) => {
      const prev = i > 0 ? pts[i - 1].total : null;
      const mom = prev != null ? p.total - prev : null;
      const momPct = prev != null && prev !== 0 ? (p.total - prev) / prev : null;
      return { ...p, mom, momPct };
    });
  }, [resp]);

  return (
    <div className="panel">
      <h2 style={{ margin: '0 0 4px' }}>Monthly Total Asset Value</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Each bar is the average total value of your <strong style={{ color: 'var(--text)' }}>current</strong> holdings across
        that month, valued at historical prices (in {ccy}) and stacked by stock, from January 2025 onward. The figure on top of
        each bar is the month's total, with its month-over-month change beneath. Because there's no transaction record, it
        reflects today's basket applied to the past — not your actual past balance.
      </p>
      {loading ? (
        <div className="loading">Loading monthly value…</div>
      ) : err ? (
        <div className="error">Failed to load: {err}</div>
      ) : data.length === 0 ? (
        <div className="loading">Not enough price history yet to chart monthly value.</div>
      ) : (
        <div style={{ width: '100%', height: 380 }}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 28, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
              <XAxis dataKey="month" tickFormatter={fmtMonth} stroke="#9aa0a6" fontSize={11} minTickGap={20} />
              <YAxis
                stroke="#9aa0a6" fontSize={11} width={52} tickFormatter={fmtCompact}
                // Headroom so the on-bar total labels aren't clipped.
                domain={[0, max => (max > 0 ? max * 1.18 : 1)]}
              />
              <Tooltip cursor={false} content={<ChartTooltip ccy={ccy} symbols={symbols} />} />
              <Legend
                formatter={(_v, entry) => symbols.find(s => s.key === entry.dataKey)?.symbol || entry.dataKey}
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              />
              {symbols.map((s, i) => {
                const isTop = i === symbols.length - 1;
                return (
                  <Bar
                    key={s.key} dataKey={s.key} name={s.symbol} stackId="v"
                    fill={colorAt(i)} maxBarSize={72}
                    radius={isTop ? [2, 2, 0, 0] : [0, 0, 0, 0]}
                  >
                    {isTop && <LabelList content={makeTotalLabel(data)} />}
                  </Bar>
                );
              })}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
