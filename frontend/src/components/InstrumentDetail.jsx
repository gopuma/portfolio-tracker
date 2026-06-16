import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { api } from '../api.js';

function fmtNum(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

// Price-chart period presets (history caps at 1825 days / 5y).
const PRESETS = [
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
  { label: '5Y', days: 1825 },
];
const MAX_DAYS = 1825;

// Indicator periods exposed as buttons for EMA and the exponential Bollinger Band.
const INDICATOR_PERIODS = [20, 50, 200];
const BB_K = 2; // Bollinger band width = EMA ± k·σ
const EMA_COLORS = { 20: '#34d399', 50: '#fbbf24', 200: '#a78bfa' };

// Exponential Moving Average. Seeds with the SMA of the first `period` closes,
// then applies k = 2/(period+1). Returns null until enough data exists.
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Rolling population standard deviation of closes over a trailing `period` window.
function rollingStd(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const mean = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

export default function InstrumentDetail() {
  const { symbol } = useParams();
  const navigate = useNavigate();
  // Go back to wherever the user came from (e.g. a portfolio's holdings), falling
  // back to the home page if there's no in-app history (deep link / refresh).
  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  };
  const [inst, setInst]       = useState(null);
  const [prices, setPrices]   = useState(null);
  const [sentiment, setSent]  = useState(null);
  const [pred, setPred]       = useState(null);
  const [err, setErr]         = useState(null);
  const [busy, setBusy]       = useState(false);
  const [days, setDays]       = useState(180);   // chart period, default 6M
  const [draft, setDraft]     = useState('180'); // custom-period input buffer
  const [emaOn, setEmaOn]     = useState({ 20: false, 50: false, 200: false }); // EMA lines toggled per period
  const [bbPeriod, setBbPeriod] = useState(null); // exponential Bollinger band period (null = off)
  const [stats, setStats]     = useState(null);  // return/risk + CAPM stats for the selected window
  const [rf, setRf]           = useState(0);     // annual risk-free rate for Sharpe/Sortino/alpha

  // Symbol-level data (instrument, sentiment, prediction) — refetched on symbol change.
  const reload = async () => {
    setErr(null);
    try {
      const [i, s, pr] = await Promise.all([
        api.instrument(symbol),
        api.sentiment(symbol, 14),
        api.prediction(symbol),
      ]);
      setInst(i); setSent(s); setPred(pr);
    } catch (e) {
      setErr(e.message);
    }
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [symbol]);

  // Prices depend on the selected period — refetch on symbol or period change.
  useEffect(() => {
    let cancelled = false;
    api.prices(symbol, days)
      .then(p => { if (!cancelled) setPrices(p); })
      .catch(e => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [symbol, days]);

  // Return/risk + CAPM stats track the same window and the risk-free rate.
  useEffect(() => {
    let cancelled = false;
    setStats(null);
    api.instrumentStats(symbol, days, rf)
      .then(s => { if (!cancelled) setStats(s); })
      .catch(() => { if (!cancelled) setStats(null); });
    return () => { cancelled = true; };
  }, [symbol, days, rf]);

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!n || n < 1) return;
    setDays(Math.min(n, MAX_DAYS));
  };

  const onRefresh = async () => {
    setBusy(true);
    try {
      await api.refresh(symbol);
      await reload();
      const p = await api.prices(symbol, days);
      setPrices(p);
    }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // Price series enriched with EMA(20/50/200) and the exponential Bollinger band.
  // EMA lines are always computed (cheap) and shown/hidden via toggles; the band
  // is only computed for the selected period. Values are null until enough data.
  const chartData = useMemo(() => {
    const rows = (prices?.prices || []).map(p => ({
      date: (p.trade_date || '').slice(0, 10),
      close: Number(p.close_px),
    }));
    const closes = rows.map(r => r.close);
    const e = { 20: ema(closes, 20), 50: ema(closes, 50), 200: ema(closes, 200) };
    let bbMid = [], bbStd = [];
    if (bbPeriod) {
      bbMid = ema(closes, bbPeriod);
      bbStd = rollingStd(closes, bbPeriod);
    }
    return rows.map((r, i) => ({
      ...r,
      ema20: e[20][i],
      ema50: e[50][i],
      ema200: e[200][i],
      bbUpper: bbPeriod && bbMid[i] != null && bbStd[i] != null ? bbMid[i] + BB_K * bbStd[i] : null,
      bbLower: bbPeriod && bbMid[i] != null && bbStd[i] != null ? bbMid[i] - BB_K * bbStd[i] : null,
    }));
  }, [prices, bbPeriod]);

  if (err) return <div className="error">Failed to load: {err}</div>;
  if (!inst || !prices || !pred) return <div className="loading">Loading {symbol}…</div>;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <a href="#back" onClick={(e) => { e.preventDefault(); goBack(); }} style={{ cursor: 'pointer' }}>← Back</a>
          <h1 style={{ margin: '8px 0 0' }}>{inst.symbol} <span style={{ color: 'var(--text-dim)', fontSize: 16 }}>{inst.display_name}</span></h1>
          <div style={{ marginTop: 4, fontSize: 13, color: 'var(--text-dim)' }}>
            {inst.market} · {inst.asset_class} · {inst.currency}
            {inst.notes ? <> · {inst.notes}</> : null}
          </div>
        </div>
        <button className="btn" onClick={onRefresh} disabled={busy}>
          {busy ? 'Refreshing…' : 'Refresh data'}
        </button>
      </div>

      <div className="grid-4">
        <Metric label="Latest Close" value={`${fmtNum(inst.latest?.close_px ?? prices.prices?.at(-1)?.close_px)} ${inst.currency}`} />
        <Metric label="5-day Prediction" value={fmtNum(pred.predicted_price)} sub={fmtPct(pred.predicted_return)} color={pred.predicted_return > 0 ? 'up' : 'down'} />
        <Metric label="Confidence" value={fmtPct(pred.confidence, 0)} />
        <Metric label="7d Sentiment" value={fmtNum(sentiment?.rolling_avg ?? 0)} sub={`${sentiment?.records?.length ?? 0} day(s)`} />
      </div>

      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Price ({days} days)</h2>
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>EMA</span>
            {INDICATOR_PERIODS.map(p => (
              <button
                key={p}
                className={`btn ${emaOn[p] ? '' : 'ghost'}`}
                onClick={() => setEmaOn(s => ({ ...s, [p]: !s[p] }))}
              >
                {p}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Bollinger (EMA ± {BB_K}σ)</span>
            {INDICATOR_PERIODS.map(p => (
              <button
                key={p}
                className={`btn ${bbPeriod === p ? '' : 'ghost'}`}
                onClick={() => setBbPeriod(cur => (cur === p ? null : p))}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        {chartData.length === 0 ? (
          <div className="loading">No price data yet — run <code>npm run backfill</code> in the backend.</div>
        ) : (
          <div style={{ width: '100%', height: 320 }}>
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="#9aa0a6" fontSize={11} minTickGap={40} />
                <YAxis stroke="#9aa0a6" fontSize={11} domain={['auto', 'auto']} />
                <Tooltip contentStyle={{ background: '#1a1f29', border: '1px solid #2d3441' }} formatter={v => fmtNum(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="close" name="Close" stroke="#4a9eff" dot={false} strokeWidth={2} />
                {bbPeriod && (
                  <Line type="monotone" dataKey="bbUpper" name={`BB Upper (${bbPeriod})`} stroke="#6b7280" strokeDasharray="4 4" dot={false} strokeWidth={1} connectNulls />
                )}
                {bbPeriod && (
                  <Line type="monotone" dataKey="bbLower" name={`BB Lower (${bbPeriod})`} stroke="#6b7280" strokeDasharray="4 4" dot={false} strokeWidth={1} connectNulls />
                )}
                {INDICATOR_PERIODS.filter(p => emaOn[p]).map(p => (
                  <Line key={p} type="monotone" dataKey={`ema${p}`} name={`EMA ${p}`} stroke={EMA_COLORS[p]} dot={false} strokeWidth={1.5} connectNulls />
                ))}
                <ReferenceLine y={pred.predicted_price} stroke="#fbbf24" strokeDasharray="4 4" label={{ value: '5d target', fill: '#fbbf24', fontSize: 11, position: 'right' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          <p style={{ margin: '0 0 8px' }}>
            <strong style={{ color: 'var(--text)' }}>EMA (Exponential Moving Average)</strong> — a trend line that averages
            past closing prices while weighting recent days more heavily (weight <em>k = 2/(N+1)</em>), so it reacts
            faster than a simple average. Shorter windows hug price and show short-term momentum; longer windows are
            smoother and mark the bigger trend. Rules of thumb: price <em>above</em> a rising EMA = uptrend, <em>below</em>
            a falling EMA = downtrend. The <strong>20</strong> (~1 month) is short-term, <strong>50</strong> (~1 quarter)
            medium-term, and <strong>200</strong> (~1 year) the long-term trend line institutions watch. When a shorter
            EMA crosses above a longer one it's bullish (a "golden cross"); crossing below is bearish (a "death cross").
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--text)' }}>Exponential Bollinger Band</strong> — a volatility envelope drawn as
            the EMA (the middle line) plus and minus {BB_K} standard deviations of price over the same window. The bands
            <em> widen</em> when the market gets more volatile and <em>contract</em> when it calms down. Price spends most
            of its time inside the bands, so a touch of the <em>upper</em> band means price is stretched high and the
            <em> lower</em> band means stretched low — but in a strong trend price can "walk the band," so band touches are
            not automatic buy/sell signals. A <strong>squeeze</strong> (bands pinching very tight) often precedes a large
            move. Using the EMA as the center makes the band react more quickly than the classic SMA-based version.
          </p>
        </div>
      </div>

      <RiskPanel stats={stats} days={days} rf={rf} setRf={setRf} />

      <div className="grid-2">
        <div className="panel">
          <h2>Prediction Factors</h2>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 0 }}>
            Each factor produces a signal in [-1, +1]. Weights: trend 30%, momentum 25%, sentiment 25%, value 20%.
          </p>
          <FactorBar label="Trend (SMA)"  value={pred.trend_signal     ?? pred.signals?.trend} />
          <FactorBar label="Momentum"     value={pred.momentum_signal  ?? pred.signals?.momentum} />
          <FactorBar label="Sentiment"    value={pred.sentiment_signal ?? pred.signals?.sentiment} />
          <FactorBar label="Value"        value={pred.value_signal     ?? pred.signals?.value} />
          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '12px 0' }} />
          <FactorBar label="Composite"    value={pred.composite_signal} bold />
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
            Model: {pred.model_version || 'heuristic-v1'} · {pred.horizon_days || 5}-day horizon
          </div>
        </div>

        <div className="panel">
          <h2>Recent Headlines</h2>
          {(sentiment?.records?.[0]?.headlines_json?.length ?? 0) === 0 ? (
            <div className="loading">No headlines yet. Try Refresh.</div>
          ) : (
            <ul className="headline-list">
              {(sentiment.records[0].headlines_json || []).slice(0, 8).map((h, i) => (
                <li key={i}>
                  <span style={{ width: 30, color: h.score > 0 ? 'var(--green)' : h.score < 0 ? 'var(--red)' : 'var(--text-dim)', fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>
                    {h.score > 0 ? '+' : ''}{h.score.toFixed(2)}
                  </span>
                  <a href={h.link} target="_blank" rel="noreferrer">{h.title}</a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function Metric({ label, value, sub, color }) {
  return (
    <div className="panel">
      <div className="metric-label">{label}</div>
      <div className={`metric ${color || ''}`}>{value}</div>
      {sub ? <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

// One stat cell for the risk grid.
function Stat({ label, value, color, title }) {
  return (
    <div title={title}>
      <div className="metric-label">{label}</div>
      <div className={`metric ${color || ''}`} style={{ fontSize: 20 }}>{value}</div>
    </div>
  );
}

// Return/risk + CAPM (alpha/beta) panel for the selected window.
function RiskPanel({ stats, days, rf, setRf }) {
  const s = stats?.stats;
  const c = stats?.capm;
  const sign = v => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0 }}>
          Risk &amp; Return <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>({days} days{c?.benchmark_name ? ` · vs ${c.benchmark_name}` : ''})</span>
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Risk-free</span>
          <input
            type="number" step={0.5} min={0} max={20}
            value={(rf * 100).toString()}
            onChange={e => setRf(Math.max(0, Number(e.target.value) / 100))}
            style={{ width: 64, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}
          />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>%</span>
        </div>
      </div>

      {!stats ? (
        <div className="loading">Computing…</div>
      ) : !s ? (
        <div className="loading">Not enough price history for this window.</div>
      ) : (
        <>
          <div className="grid-4" style={{ marginTop: 16, rowGap: 16 }}>
            <Stat label="Return (ann.)" value={fmtPct(s.cagr)} color={sign(s.cagr)} title="Realized annualized return (CAGR)" />
            <Stat label="Volatility" value={fmtPct(s.vol)} title="Annualized standard deviation of daily returns" />
            <Stat label="Downside Dev" value={fmtPct(s.downside_dev)} title="Annualized downside deviation — only returns below the risk-free MAR count" />
            <Stat label="Max Drawdown" value={fmtPct(s.max_drawdown)} color="down" title="Worst peak-to-trough decline over the window" />
            <Stat label="Sharpe" value={fmtNum(s.sharpe)} color={sign(s.sharpe)} title="(Ann. mean return − rf) / volatility" />
            <Stat label="Sortino" value={fmtNum(s.sortino)} color={sign(s.sortino)} title="(Ann. mean return − rf) / downside deviation" />
            <Stat label="Beta" value={fmtNum(c?.beta)} title={`Sensitivity to ${c?.benchmark_name || 'the market'} (1 = moves with it)`} />
            <Stat label="Alpha (ann.)" value={fmtPct(c?.alpha)} color={sign(c?.alpha)} title={`Jensen's alpha vs ${c?.benchmark_name || 'the market'} — excess return CAPM can't explain`} />
          </div>

          <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            <p style={{ margin: '0 0 6px' }}>
              <strong style={{ color: 'var(--text)' }}>Volatility</strong> is total bumpiness (annualized σ of daily returns);
              <strong style={{ color: 'var(--text)' }}> Downside Dev</strong> counts only losses below the risk-free target.
              <strong style={{ color: 'var(--text)' }}> Sharpe</strong> = return per unit of total risk,
              <strong style={{ color: 'var(--text)' }}> Sortino</strong> = return per unit of downside risk (higher is better; &gt;1 good, &gt;2 strong).
              <strong style={{ color: 'var(--text)' }}> Max Drawdown</strong> is the worst peak-to-trough loss.
            </p>
            <p style={{ margin: 0 }}>
              <strong style={{ color: 'var(--text)' }}>Beta</strong> measures how much the asset moves with {c?.benchmark_name || 'the market'}:
              {' '}1 = in step, &gt;1 = amplifies it, &lt;1 = muted, negative = moves opposite.
              <strong style={{ color: 'var(--text)' }}> Alpha</strong> is the annualized excess return beyond what beta predicts —
              positive alpha = outperformed its market risk, negative = underperformed.
              {c?.r2 != null && <> The benchmark explains <strong style={{ color: 'var(--text)' }}>{fmtPct(c.r2, 0)}</strong> of this asset's moves (R²).</>}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function FactorBar({ label, value, bold }) {
  const v = Number(value ?? 0);
  const width = Math.abs(v) * 50; // % of half-bar
  const left  = v >= 0 ? '50%' : `${50 - width}%`;
  const color = v >= 0 ? 'var(--green)' : 'var(--red)';
  return (
    <div className="factor-row" style={{ fontWeight: bold ? 600 : 400 }}>
      <div className="label">{label}</div>
      <div className="bar-bg">
        <div className="bar" style={{ left, width: `${width}%`, background: color }} />
      </div>
      <div className="val" style={{ color }}>{v.toFixed(2)}</div>
    </div>
  );
}
