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

const GREEN = '#34d399';
const RED = '#f87171';
const DIM = '#9aa0a6';

// Custom tooltip showing the exact value and the month-over-month change.
function ChartTooltip({ active, payload, ccy }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const color = p.mom == null ? DIM : p.mom > 0 ? GREEN : p.mom < 0 ? RED : DIM;
  return (
    <div style={{ background: '#1a1f29', border: '1px solid #2d3441', borderRadius: 6, padding: '8px 10px', fontSize: 12 }}>
      <div style={{ color: DIM, marginBottom: 4 }}>{p.month}</div>
      <div style={{ color: '#e6e6e6', fontWeight: 600 }}>{fmtMoney(p.value, ccy)}</div>
      {p.mom != null && (
        <div style={{ color, marginTop: 2 }}>
          {p.mom > 0 ? '▲' : p.mom < 0 ? '▼' : ''} {fmtMoney(Math.abs(p.mom), ccy)}
          {p.momPct != null ? ` (${fmtPct(Math.abs(p.momPct))})` : ''} MoM
        </div>
      )}
    </div>
  );
}

// Per-bar label: the month's average total value, with the MoM change beneath it.
function makeBarLabel(points) {
  return function BarLabel({ x, y, width, index }) {
    const p = points[index];
    if (!p || x == null || y == null) return null;
    const cx = x + width / 2;
    let momText = '';
    let momColor = DIM;
    if (p.mom != null) {
      momColor = p.mom > 0 ? GREEN : p.mom < 0 ? RED : DIM;
      const arrow = p.mom > 0 ? '▲' : p.mom < 0 ? '▼' : '';
      momText = `${arrow} ${p.momPct != null ? fmtPct(Math.abs(p.momPct)) : fmtCompact(Math.abs(p.mom))}`;
    }
    return (
      <g>
        <text x={cx} y={y - 16} textAnchor="middle" fontSize={11} fontWeight={600} fill="#e6e6e6">
          {fmtCompact(p.value)}
        </text>
        {momText && (
          <text x={cx} y={y - 4} textAnchor="middle" fontSize={10} fill={momColor}>
            {momText}
          </text>
        )}
      </g>
    );
  };
}

// Monthly average total asset value of the portfolio's current holdings, valued at
// historical prices. Each bar is one month's average total value in the base currency.
export default function PortfolioValueChart({ portfolioId, base }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.portfolioValueHistory(portfolioId)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [portfolioId]);

  const ccy = data?.base_currency || base;
  // Attach month-over-month change (absolute and %) to each point.
  const points = useMemo(() => {
    const raw = data?.points || [];
    return raw.map((p, i) => {
      const prev = i > 0 ? raw[i - 1].value : null;
      const mom = prev != null ? p.value - prev : null;
      const momPct = prev != null && prev !== 0 ? (p.value - prev) / prev : null;
      return { month: fmtMonth(p.month), value: p.value, mom, momPct };
    });
  }, [data]);

  return (
    <div className="panel">
      <h2 style={{ margin: '0 0 4px' }}>Monthly Total Asset Value</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Each bar is the average total value of your <strong style={{ color: 'var(--text)' }}>current</strong> holdings across
        that month, valued at historical prices (in {ccy}), from January 2025 onward. The figure on top of each bar is the
        month's average value, with its month-over-month change beneath. Because there's no transaction record, it reflects
        today's basket applied to the past — not your actual past balance.
      </p>
      {loading ? (
        <div className="loading">Loading monthly value…</div>
      ) : err ? (
        <div className="error">Failed to load: {err}</div>
      ) : points.length === 0 ? (
        <div className="loading">Not enough price history yet to chart monthly value.</div>
      ) : (
        <div style={{ width: '100%', height: 320 }}>
          <ResponsiveContainer>
            <BarChart data={points} margin={{ top: 28, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
              <XAxis dataKey="month" stroke="#9aa0a6" fontSize={11} minTickGap={20} />
              <YAxis
                stroke="#9aa0a6" fontSize={11} width={52} tickFormatter={fmtCompact}
                // Headroom so the on-bar labels above the tallest bar aren't clipped.
                domain={[0, max => (max > 0 ? max * 1.18 : 1)]}
              />
              {/* cursor=false removes recharts' default full-width hover highlight,
                  which was far wider than the bar. */}
              <Tooltip cursor={false} content={<ChartTooltip ccy={ccy} />} />
              <Bar dataKey="value" fill="#4a9eff" radius={[2, 2, 0, 0]} maxBarSize={72}>
                <LabelList content={makeBarLabel(points)} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
