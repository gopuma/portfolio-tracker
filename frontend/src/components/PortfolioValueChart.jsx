import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api.js';

function fmtMoney(n, ccy, d = 0) {
  if (n == null || isNaN(n)) return '–';
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: d })} ${ccy || ''}`.trim();
}
// Compact axis labels: 1_250_000 -> "1.3M".
function fmtCompact(n) {
  if (n == null || isNaN(n)) return '';
  return Number(n).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
}
// 'YYYY-MM' -> "Jan '24". Built as local time so the month doesn't slip.
function fmtMonth(ym) {
  const [y, m] = (ym || '').split('-');
  if (!y || !m) return ym;
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
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
  const points = useMemo(
    () => (data?.points || []).map(p => ({ month: fmtMonth(p.month), value: p.value })),
    [data]
  );

  return (
    <div className="panel">
      <h2 style={{ margin: '0 0 4px' }}>Monthly Total Asset Value</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Each bar is the average total value of your <strong style={{ color: 'var(--text)' }}>current</strong> holdings across
        that month, valued at historical prices (in {ccy}). It begins when every holding has price history. Because there's no
        transaction record, it reflects today's basket applied to the past — not your actual past balance.
      </p>
      {loading ? (
        <div className="loading">Loading monthly value…</div>
      ) : err ? (
        <div className="error">Failed to load: {err}</div>
      ) : points.length === 0 ? (
        <div className="loading">Not enough price history yet to chart monthly value.</div>
      ) : (
        <div style={{ width: '100%', height: 300 }}>
          <ResponsiveContainer>
            <BarChart data={points}>
              <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
              <XAxis dataKey="month" stroke="#9aa0a6" fontSize={11} minTickGap={20} />
              <YAxis stroke="#9aa0a6" fontSize={11} width={52} tickFormatter={fmtCompact} domain={['auto', 'auto']} />
              <Tooltip
                contentStyle={{ background: '#1a1f29', border: '1px solid #2d3441' }}
                formatter={v => [fmtMoney(v, ccy), 'Avg value']}
                labelStyle={{ color: '#9aa0a6' }}
              />
              <Bar dataKey="value" fill="#4a9eff" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
