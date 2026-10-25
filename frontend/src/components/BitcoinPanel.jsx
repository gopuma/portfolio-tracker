import { useEffect, useMemo, useState } from 'react';
import { ComposedChart, LineChart, Line, Area, Brush, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { api } from '../api.js';
import { rowsOf, mergeGold, averages, axisRange } from '../goldSeries.js';
import { usdToKrw } from '../btcSeries.js';

const UPBIT_SYMBOL = 'UPBIT-KRW-BTC';
const GLOBAL_SYMBOL = 'BTC-USD';
const FX_SYMBOL = 'KRW=X';
const MAX_DAYS = 1825;

// Trend-chart period presets (history caps at 1825 days / 5y).
const PRESETS = [
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
  { label: '5Y', days: 1825 },
];

const UPBIT_COLOR = '#f7931a';  // bitcoin orange
const GLOBAL_COLOR = '#4a9eff'; // blue

function fmtNum(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

// Won amounts in 백만 (millions) on the axis, so ticks stay short: 108,000,000 → 108M.
const fmtKrwM = v => `${fmtNum(v / 1e6, 0)}M`;

const tone = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');

function fmtKstTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

/**
 * Bitcoin on the Overview: Upbit's won price against the global price (BTC-USD restated
 * in won), the Korean premium between them, and their price history. Laid out like the
 * gold panel above it.
 */
export default function BitcoinPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [upbitHist, setUpbitHist] = useState(null);
  const [globalHist, setGlobalHist] = useState(null);
  const [fxHist, setFxHist] = useState(null);

  useEffect(() => {
    const load = () => api.bitcoin().then(d => { setData(d); setErr(null); }).catch(e => setErr(e.message));
    load();
    // Bitcoin trades around the clock; refresh the live prices every 60s.
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    api.prices(UPBIT_SYMBOL, MAX_DAYS).then(d => setUpbitHist(d.prices || [])).catch(() => {});
    api.prices(GLOBAL_SYMBOL, MAX_DAYS).then(d => setGlobalHist(d.prices || [])).catch(() => {});
    api.prices(FX_SYMBOL, MAX_DAYS).then(d => setFxHist(d.prices || [])).catch(() => {});
  }, []);

  const upbitRows = useMemo(() => rowsOf(upbitHist), [upbitHist]);
  // Global bitcoin in won at each day's exchange rate, so both share one unit.
  const globalRows = useMemo(() => usdToKrw(rowsOf(globalHist), rowsOf(fxHist)), [globalHist, fxHist]);
  const upbitAvgs = useMemo(() => averages(upbitRows), [upbitRows]);
  const globalAvgs = useMemo(() => averages(globalRows), [globalRows]);

  const lastDataDate = useMemo(() => {
    const dates = [...upbitRows, ...globalRows].map(r => r.t);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [upbitRows, globalRows]);

  const [days, setDays] = useState(365);
  const [draft, setDraft] = useState('365');

  // Both series by date for the selected period. mergeGold is the gold panel's generic
  // merge: `krx` holds Upbit and `intl` the global price here.
  const chartData = useMemo(() => {
    const c = new Date();
    c.setDate(c.getDate() - days);
    return mergeGold(upbitRows, globalRows, c.toISOString().slice(0, 10));
  }, [upbitRows, globalRows, days]);

  // Window picked with the slider under the price chart (null: the whole period). Both
  // charts show it, and both axes refit to it.
  const [win, setWin] = useState(null);
  useEffect(() => setWin(null), [days]);
  const shown = useMemo(
    () => (win ? chartData.slice(win.startIndex, win.endIndex + 1) : chartData),
    [chartData, win]
  );

  const premiumData = useMemo(() => shown.filter(e => e.premium != null), [shown]);
  const avgPremium = premiumData.length ? premiumData.reduce((a, e) => a + e.premium, 0) / premiumData.length : null;

  const priceAxis = useMemo(() => axisRange(shown.flatMap(e => [e.krx, e.intl]), { ticks: 8 }), [shown]);
  const premiumAxis = useMemo(() => axisRange(premiumData.map(e => e.premium), { ticks: 7, clip: 0.01, include: [0] }), [premiumData]);

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!n || n < 1) return;
    setDays(Math.min(n, MAX_DAYS));
  };

  if (err && !data) return <div className="panel"><h2>Bitcoin</h2><div className="error">Failed: {err}</div></div>;
  if (!data) return <div className="panel"><h2>Bitcoin</h2><div className="loading">Loading…</div></div>;

  const { upbit, global, fx, premium } = data;
  const live = upbit.live;
  const asOf = lastDataDate
    ? new Date(`${lastDataDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div className="panel">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h2 style={{ margin: 0 }}>Bitcoin: Upbit vs Global</h2>
        {asOf && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Data as of {asOf}</span>}
      </div>
      <div className="grid-3" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="metric-label">
            Upbit (KRW)
            {live && <span className="pill green" style={{ marginLeft: 8 }}>LIVE</span>}
          </div>
          <div className="metric">{fmtNum(upbit.latest_krw, 0)} <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>KRW</span></div>
          {live && (
            <div style={{ fontSize: 12, marginTop: 2 }}>
              <span className={tone(live.change)}>{live.change > 0 ? '▲' : live.change < 0 ? '▼' : ''} {fmtNum(live.change, 0)} ({fmtPct(live.change_pct)})</span>
              <span style={{ color: 'var(--text-dim)' }}> since 09:00 KST</span>
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
            {upbit.display_name} · {upbit.symbol}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
            {live ? `as of ${fmtKstTime(live.traded_at)} KST` : 'latest stored close'}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            30d: <span className={tone(upbit.return_30d)}>{fmtPct(upbit.return_30d)}</span>
          </div>
          <AvgBlock avgs={upbitAvgs} current={upbit.latest_krw} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="metric-label">Global (USD)</div>
          <div className="metric">{fmtNum(global.latest_usd, 0)} <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>USD</span></div>
          {global.live?.change != null && (
            <div style={{ fontSize: 12, marginTop: 2 }}>
              <span className={tone(global.live.change)}>{global.live.change > 0 ? '▲' : global.live.change < 0 ? '▼' : ''} {fmtNum(global.live.change, 0)} ({fmtPct(global.live.change_percent / 100)})</span>
              <span style={{ color: 'var(--text-dim)' }}> since 00:00 UTC</span>
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
            {global.display_name} · {global.symbol}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            30d: <span className={tone(global.return_30d)}>{fmtPct(global.return_30d)}</span>
            {global.return_30d_krw != null && (
              <span style={{ color: 'var(--text-dim)' }}>
                {' '}· in KRW <span className={tone(global.return_30d_krw)}>{fmtPct(global.return_30d_krw)}</span>
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
            ≈ {fmtNum(global.latest_krw, 0)} KRW at today's rate
          </div>
          <AvgBlock avgs={globalAvgs} current={global.latest_krw} />
        </div>

        <div>
          <div className="metric-label">Korean Premium (Upbit − Global)</div>
          <div className={`metric ${tone(premium.pct)}`}>{fmtPct(premium.pct)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {fmtNum(premium.krw, 0)} KRW · USD/KRW {fmtNum(fx.krw_per_usd, 2)}
          </div>
          <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text-dim)' }}>
            30d return diff (both in KRW): <span className={tone(premium.return_30d_diff)}>{fmtPct(premium.return_30d_diff)}</span>
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
        <>
          <div style={{ width: '100%', height: 420, marginTop: 12 }}>
            <ResponsiveContainer>
              <ComposedChart data={chartData}>
                <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="#9aa0a6" fontSize={11} minTickGap={40} />
                <YAxis stroke="#9aa0a6" fontSize={11} domain={priceAxis.domain} ticks={priceAxis.ticks} tickFormatter={fmtKrwM} width={64} />
                <Tooltip
                  contentStyle={{ background: '#1a1f29', border: '1px solid #2d3441' }}
                  formatter={(v, name) => [`${fmtNum(v, 0)} KRW`, name]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} verticalAlign="top" />
                {/* The gap itself, shaded: orange where Upbit is above, blue where below. */}
                <Area type="monotone" dataKey="above" name="Upbit above" fill={UPBIT_COLOR} fillOpacity={0.45} stroke="none" legendType="square" tooltipType="none" connectNulls isAnimationActive={false} />
                <Area type="monotone" dataKey="below" name="Upbit below" fill={GLOBAL_COLOR} fillOpacity={0.45} stroke="none" legendType="square" tooltipType="none" connectNulls isAnimationActive={false} />
                <Line type="monotone" dataKey="krx" name="Upbit" stroke={UPBIT_COLOR} dot={false} strokeWidth={1.5} connectNulls isAnimationActive={false} />
                <Line type="monotone" dataKey="intl" name="Global (in KRW)" stroke={GLOBAL_COLOR} dot={false} strokeWidth={1.5} connectNulls isAnimationActive={false} />
                <Brush
                  key={days}
                  dataKey="date"
                  startIndex={win ? win.startIndex : 0}
                  endIndex={win ? win.endIndex : Math.max(0, chartData.length - 1)}
                  height={26}
                  stroke="#4a9eff"
                  fill="#1a1f29"
                  travellerWidth={8}
                  tickFormatter={() => ''}
                  onChange={r => setWin(r.startIndex === 0 && r.endIndex === chartData.length - 1 ? null : r)}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
            Axis in millions of won. Global bitcoin (BTC-USD) converted to KRW at each day's USD/KRW rate (weekends use Friday's rate).
            Drag the slider's ends to zoom into a stretch of time; the scale refits so the gap shows more.
          </div>

          {premiumData.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
                <h3 style={{ margin: 0 }}>Korean Premium</h3>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  average over {win ? `${shown[0]?.date} – ${shown[shown.length - 1]?.date}` : 'the period'} <span className={tone(avgPremium)}>{fmtPct(avgPremium)}</span>
                </span>
              </div>
              <div style={{ width: '100%', height: 220, marginTop: 8 }}>
                <ResponsiveContainer>
                  <LineChart data={premiumData}>
                    <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
                    <XAxis dataKey="date" stroke="#9aa0a6" fontSize={11} minTickGap={40} />
                    <YAxis stroke="#9aa0a6" fontSize={11} domain={premiumAxis.domain} ticks={premiumAxis.ticks} allowDataOverflow tickFormatter={v => fmtPct(v, 1)} width={64} />
                    <Tooltip
                      contentStyle={{ background: '#1a1f29', border: '1px solid #2d3441' }}
                      formatter={v => [fmtPct(v), 'Upbit over global']}
                    />
                    <ReferenceLine y={0} stroke="#9aa0a6" />
                    <Line type="monotone" dataKey="premium" stroke={UPBIT_COLOR} dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                Both daily prices close at 09:00 KST (00:00 UTC), so each day compares like with like; the rate is the day's USD/KRW close.
                {premiumAxis.clipped > 0 && ` ${premiumAxis.clipped} unusual ${premiumAxis.clipped === 1 ? 'day runs' : 'days run'} off the scale; hover for the value.`}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// Compact 1Y/3Y/5Y average list (KRW) with the current price's deviation from each.
function AvgBlock({ avgs, current }) {
  const rows = [
    ['1Y avg', avgs.y1],
    ['3Y avg', avgs.y3],
    ['5Y avg', avgs.y5],
  ];
  return (
    <div style={{ marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      {rows.map(([label, v]) => {
        const diff = v && current != null ? current / v - 1 : null;
        return (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: 'var(--text-dim)' }}>{label}</span>
            <span>
              {fmtNum(v, 0)} <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>KRW</span>
              {diff != null && <span className={tone(diff)} style={{ marginLeft: 6 }}>{diff > 0 ? '+' : ''}{fmtPct(diff)}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
