import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api.js';

const KRX_SYMBOL = 'KRX-GOLD-SPOT';
const INTL_SYMBOL = 'GC=F';
const MAX_DAYS = 1825;

// Trend-chart period presets (history caps at 1825 days / 5y).
const PRESETS = [
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
  { label: '5Y', days: 1825 },
];

const KRX_COLOR = '#fbbf24';  // amber
const INTL_COLOR = '#4a9eff'; // blue

// 1Y / 3Y / 5Y mean close from a daily price series ([{trade_date, close_px}]).
// Windows that run past the available history just average whatever exists.
function computeAverages(prices) {
  const rows = (prices || [])
    .map(p => ({ t: (p.trade_date || '').slice(0, 10), v: Number(p.close_px) }))
    .filter(r => r.t && !isNaN(r.v));
  const avgOver = nDays => {
    if (rows.length === 0) return null;
    const c = new Date();
    c.setDate(c.getDate() - nDays);
    const cut = c.toISOString().slice(0, 10);
    const sel = rows.filter(r => r.t >= cut);
    if (sel.length === 0) return null;
    return sel.reduce((a, r) => a + r.v, 0) / sel.length;
  };
  return { y1: avgOver(365), y3: avgOver(1095), y5: avgOver(MAX_DAYS) };
}

function fmtNum(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

function fmtKstTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

export default function GoldGapPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [krxHist, setKrxHist] = useState(null);
  const [intlHist, setIntlHist] = useState(null);

  useEffect(() => {
    const load = () => api.goldGap().then(setData).catch(e => setErr(e.message));
    load();
    // Auto-refresh every 60s so live KRX prices stay current while market is open.
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  // Fetch full history once for the 1Y/3Y/5Y averages (fixed, independent of live data).
  useEffect(() => {
    api.prices(KRX_SYMBOL, MAX_DAYS).then(d => setKrxHist(d.prices || [])).catch(() => {});
    api.prices(INTL_SYMBOL, MAX_DAYS).then(d => setIntlHist(d.prices || [])).catch(() => {});
  }, []);

  const krxAvgs = useMemo(() => computeAverages(krxHist), [krxHist]);
  const intlAvgs = useMemo(() => computeAverages(intlHist), [intlHist]);

  const [days, setDays] = useState(365); // chart period, default 1Y
  const [draft, setDraft] = useState('365'); // custom-period input buffer

  // Merge both series by date for the dual-axis trend chart, filtered to the selected period.
  const chartData = useMemo(() => {
    const c = new Date();
    c.setDate(c.getDate() - days);
    const cut = c.toISOString().slice(0, 10);
    const map = new Map();
    for (const p of krxHist || []) {
      const t = (p.trade_date || '').slice(0, 10);
      if (t >= cut) map.set(t, { date: t, krx: Number(p.close_px) });
    }
    for (const p of intlHist || []) {
      const t = (p.trade_date || '').slice(0, 10);
      if (t < cut) continue;
      const e = map.get(t) || { date: t };
      e.intl = Number(p.close_px);
      map.set(t, e);
    }
    return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [krxHist, intlHist, days]);

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!n || n < 1) return;
    setDays(Math.min(n, MAX_DAYS));
  };

  if (err) return <div className="panel"><h2>Gold Gap</h2><div className="error">Failed: {err}</div></div>;
  if (!data) return <div className="panel"><h2>Gold Gap</h2><div className="loading">Loading…</div></div>;

  const { krx, intl, fx, gap } = data;
  const pct = gap?.premium_pct;
  const pctColor = pct == null ? '' : pct > 0 ? 'up' : 'down';
  const live = krx.live;
  const liveDir = live?.direction;
  const liveColor = liveDir === 'RISING' ? 'up' : liveDir === 'FALLING' ? 'down' : '';
  const arrow = liveDir === 'RISING' ? '▲' : liveDir === 'FALLING' ? '▼' : '';
  const statusPill = live?.market_status === 'OPEN'
    ? <span className="pill green" style={{ marginLeft: 8 }}>LIVE</span>
    : <span className="pill" style={{ marginLeft: 8 }}>CLOSE</span>;

  return (
    <div className="panel">
      <h2>Gold: KRX vs International</h2>
      <div className="grid-3">
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="metric-label">KRX (Korean Market) {live ? statusPill : null}</div>
          <div className="metric">{fmtNum(krx.latest_krw_per_g, 2)} <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>KRW/g</span></div>
          {live ? (
            <div style={{ fontSize: 12, marginTop: 2 }}>
              <span className={liveColor}>{arrow} {fmtNum(live.fluctuation_krw, 2)} ({fmtPct(live.fluctuation_pct)})</span>
            </div>
          ) : null}
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
            {krx.display_name} · {krx.symbol}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
            {live ? `as of ${fmtKstTime(live.local_traded_at)} KST` : null}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            30d: <span className={krx.return_30d > 0 ? 'up' : krx.return_30d < 0 ? 'down' : ''}>{fmtPct(krx.return_30d)}</span>
          </div>
          <AvgBlock avgs={krxAvgs} current={krx.latest_krw_per_g} unit="KRW/g" digits={0} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="metric-label">International (US Market)</div>
          <div className="metric">{fmtNum(intl.latest_usd_per_oz, 2)} <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>USD/oz</span></div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {intl.display_name} · {intl.symbol}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            30d: <span className={intl.return_30d > 0 ? 'up' : intl.return_30d < 0 ? 'down' : ''}>{fmtPct(intl.return_30d)}</span>
            <span style={{ marginLeft: 8, color: 'var(--text-dim)' }}>
              ≈ {fmtNum(intl.latest_krw_per_g, 0)} KRW/g
            </span>
          </div>
          <AvgBlock avgs={intlAvgs} current={intl.latest_usd_per_oz} unit="USD/oz" digits={2} />
        </div>

        <div>
          <div className="metric-label">Korean Premium (KRX − Intl)</div>
          <div className={`metric ${pctColor}`}>{fmtPct(pct)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {fmtNum(gap?.premium_krw_per_g, 0)} KRW/g · USD/KRW {fmtNum(fx.krw_per_usd, 2)}
          </div>
          <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text-dim)' }}>
            30d return diff: <span className={gap?.return_30d_diff > 0 ? 'up' : 'down'}>{fmtPct(gap?.return_30d_diff)}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>Price Trend</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {PRESETS.map(p => (
            <button
              key={p.label}
              className={`btn ${days === p.days ? '' : 'ghost'}`}
              onClick={() => { setDays(p.days); setDraft(String(p.days)); }}
            >
              {p.label}
            </button>
          ))}
          <input
            type="number"
            min={1}
            max={MAX_DAYS}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') applyDraft(); }}
            style={{
              width: 80,
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              padding: '6px 8px',
              fontSize: 13,
              fontVariantNumeric: 'tabular-nums',
            }}
          />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>days</span>
          <button className="btn" onClick={applyDraft}>Apply</button>
        </div>
      </div>

      {chartData.length === 0 ? (
        <div className="loading">No price history yet.</div>
      ) : (
        <div style={{ width: '100%', height: 300, marginTop: 12 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke="#9aa0a6" fontSize={11} minTickGap={40} />
              <YAxis yAxisId="krx" orientation="left" stroke={KRX_COLOR} fontSize={11} domain={['auto', 'auto']} tickFormatter={v => fmtNum(v, 0)} width={56} />
              <YAxis yAxisId="intl" orientation="right" stroke={INTL_COLOR} fontSize={11} domain={['auto', 'auto']} tickFormatter={v => fmtNum(v, 0)} width={48} />
              <Tooltip
                contentStyle={{ background: '#1a1f29', border: '1px solid #2d3441' }}
                formatter={(v, name) => [fmtNum(v, name === 'KRX (KRW/g)' ? 0 : 2), name]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="krx" type="monotone" dataKey="krx" name="KRX (KRW/g)" stroke={KRX_COLOR} dot={false} strokeWidth={2} connectNulls />
              <Line yAxisId="intl" type="monotone" dataKey="intl" name="Intl (USD/oz)" stroke={INTL_COLOR} dot={false} strokeWidth={2} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// Compact 1Y/3Y/5Y average list with the current price's deviation from each.
function AvgBlock({ avgs, current, unit, digits = 2 }) {
  const rows = [
    ['1Y avg', avgs.y1],
    ['3Y avg', avgs.y3],
    ['5Y avg', avgs.y5],
  ];
  return (
    <div style={{ marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      {rows.map(([label, v]) => {
        const diff = v && current != null ? current / v - 1 : null;
        const color = diff == null ? '' : diff > 0 ? 'up' : diff < 0 ? 'down' : '';
        return (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: 'var(--text-dim)' }}>{label}</span>
            <span>
              {fmtNum(v, digits)} <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>{unit}</span>
              {diff != null && <span className={color} style={{ marginLeft: 6 }}>{diff > 0 ? '+' : ''}{fmtPct(diff)}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
