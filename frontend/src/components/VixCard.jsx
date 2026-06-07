import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { api } from '../api.js';

function fmtNum(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

const PRESETS = [
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
  { label: '5Y', days: 1825 },
];
const MAX_DAYS = 1825;

// VIX regime by level — the conventional "fear gauge" bands.
function regime(v) {
  if (v == null) return { label: '–', cls: '', color: 'var(--text-dim)' };
  if (v < 12) return { label: 'Very Low — complacency', cls: 'up', color: 'var(--green)' };
  if (v < 20) return { label: 'Calm', cls: 'up', color: 'var(--green)' };
  if (v < 30) return { label: 'Elevated', cls: '', color: 'var(--amber)' };
  if (v < 40) return { label: 'High — fear', cls: 'down', color: 'var(--red)' };
  return { label: 'Extreme — panic', cls: 'down', color: 'var(--red)' };
}

export default function VixCard() {
  const [days, setDays] = useState(180);
  const [draft, setDraft] = useState('180');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.vix(days)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  const chartData = useMemo(
    () => (data?.prices || []).map(p => ({ date: (p.trade_date || '').slice(0, 10), vix: Number(p.close_px) })),
    [data]
  );

  const first = chartData[0]?.vix;
  const last = chartData.at(-1)?.vix;
  const change = first != null && last != null ? last - first : null;
  const changePct = first ? change / first : null;
  // VIX up = more fear (red); VIX down = calmer (green) — inverted vs. a normal asset.
  const changeColor = change == null ? '' : change > 0 ? 'down' : change < 0 ? 'up' : '';
  const reg = regime(last);

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!n || n < 1) return;
    setDays(Math.min(n, MAX_DAYS));
  };

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0 }}>VIX — Volatility Index</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {PRESETS.map(p => (
            <button key={p.label} className={`btn ${days === p.days ? '' : 'ghost'}`} onClick={() => { setDays(p.days); setDraft(String(p.days)); }}>
              {p.label}
            </button>
          ))}
          <input
            type="number" min={1} max={MAX_DAYS} value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') applyDraft(); }}
            style={inputStyle}
          />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>days</span>
          <button className="btn" onClick={applyDraft}>Apply</button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
        <div className="metric">{fmtNum(last)}</div>
        <span className="pill" style={{ background: 'transparent', border: `1px solid ${reg.color}`, color: reg.color }}>{reg.label}</span>
        {change != null && (
          <div className={changeColor} style={{ fontSize: 14 }}>
            {change > 0 ? '▲' : change < 0 ? '▼' : ''} {fmtNum(Math.abs(change))} ({fmtPct(changePct)})
            <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>over period</span>
          </div>
        )}
      </div>

      {loading ? (
        <div className="loading">Loading VIX…</div>
      ) : err ? (
        <div className="error">Failed to load: {err}</div>
      ) : chartData.length === 0 ? (
        <div className="loading">No VIX history yet — backfill <code>^VIX</code>.</div>
      ) : (
        <div style={{ width: '100%', height: 300, marginTop: 12 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke="#9aa0a6" fontSize={11} minTickGap={40} />
              <YAxis stroke="#9aa0a6" fontSize={11} domain={['auto', 'auto']} width={36} />
              <Tooltip contentStyle={{ background: '#1a1f29', border: '1px solid #2d3441' }} formatter={v => [fmtNum(v), 'VIX']} />
              {/* Regime guide lines: 20 = calm/elevated boundary, 30 = fear threshold */}
              <ReferenceLine y={20} stroke="#fbbf24" strokeDasharray="4 4" label={{ value: '20', fill: '#fbbf24', fontSize: 10, position: 'right' }} />
              <ReferenceLine y={30} stroke="#f87171" strokeDasharray="4 4" label={{ value: '30', fill: '#f87171', fontSize: 10, position: 'right' }} />
              <Line type="monotone" dataKey="vix" stroke="#4a9eff" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <p style={{ marginTop: 12, marginBottom: 0, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        The <strong style={{ color: 'var(--text)' }}>VIX</strong> is the market's expected 30-day volatility of the S&amp;P 500,
        implied from option prices — the "fear gauge." Rough bands: <span className="up">&lt; 20 calm</span>,
        <span style={{ color: 'var(--amber)' }}> 20–30 elevated</span>, <span className="down"> &gt; 30 fear</span>.
        It usually rises when stocks fall, so it tends to be <em>negatively correlated</em> with equities — a quick read on
        market stress.
      </p>
    </div>
  );
}

const inputStyle = {
  width: 80,
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '6px 8px',
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
};
