import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, ReferenceLine, Cell, LabelList, ErrorBar } from 'recharts';
import { api } from '../api.js';
import {
  GREEN, RED, DIM, ACCENT, BASELINE, BASELINE_OPACITY, DIMMED_OPACITY, tooltipStyle, inputStyle, dimLabel,
  fmtPct, fmtNum, fmtMoney, fmtCompact, cls, HoldingPctLabel, PortfolioTick, PortfolioChips,
} from './stressShared.jsx';
import HistoricalReplay from './HistoricalReplay.jsx';

const WHISKER = '#c9ced6';

/**
 * One-standard-deviation band for a sum of holdings, as % changes from `current`. The sum's
 * dollar spread `sd` is converted to an equivalent log-normal spread around `stressed`, so
 * the band stays skewed like its holdings' bands and can never reach below −100% — a plain
 * ± in dollars would, for a small portfolio over a long move.
 */
function bandOf(current, stressed, sd) {
  if (!(current > 0) || !(stressed > 0)) return { lo: 0, hi: 0 };
  const sigma = Math.sqrt(Math.log(1 + (sd / stressed) ** 2));
  return { lo: (stressed * Math.exp(-sigma)) / current - 1, hi: (stressed * Math.exp(sigma)) / current - 1 };
}
const fmtRange = (lo, hi) => `${fmtPct(lo, 0)} to ${fmtPct(hi, 0)}`;

// Historical index moves, peak to trough for a crash and trough to peak for a boom, as a
// signed % change. `days` is the calendar length of the move, which sets how much room
// each holding's own (non-market) swings get, and how long alpha runs if it's switched on.
const SCENARIOS = [
  { key: 'black-monday', kind: 'crash', label: 'Black Monday 1987', index: '^GSPC', change: -20.5, days: 1, note: 'S&P 500, 19 Oct 1987, in one session' },
  { key: 'dotcom-crash', kind: 'crash', label: 'Dot-com crash 2000–02', index: '^IXIC', change: -78, days: 943, note: 'NASDAQ, 10 Mar 2000 – 9 Oct 2002' },
  { key: 'gfc', kind: 'crash', label: 'Financial crisis 2007–09', index: '^GSPC', change: -57, days: 517, note: 'S&P 500, 9 Oct 2007 – 9 Mar 2009' },
  { key: 'covid', kind: 'crash', label: 'COVID crash 2020', index: '^GSPC', change: -34, days: 33, note: 'S&P 500, 19 Feb – 23 Mar 2020' },
  { key: 'bear-2022', kind: 'crash', label: 'Rate shock 2022', index: '^IXIC', change: -36, days: 404, note: 'NASDAQ, 19 Nov 2021 – 28 Dec 2022' },
  { key: 'dotcom-bubble', kind: 'boom', label: 'Dot-com bubble 1998–2000', index: '^IXIC', change: 256, days: 519, note: 'NASDAQ, 8 Oct 1998 – 10 Mar 2000' },
  { key: 'covid-rally', kind: 'boom', label: 'Post-COVID rally 2020–22', index: '^GSPC', change: 114, days: 651, note: 'S&P 500, 23 Mar 2020 – 3 Jan 2022' },
  // Ends at the NASDAQ high in this app's own price history, so it moves with the data.
  { key: 'ai-boom', kind: 'boom', label: 'AI boom 2023–26', index: '^IXIC', change: 170, days: 1378, note: 'NASDAQ, 28 Dec 2022 – 6 Oct 2026, from the post-ChatGPT low' },
];
const SCENARIO_GROUPS = [
  { kind: 'crash', label: 'Crashes' },
  { kind: 'boom', label: 'Booms' },
];
// Slider reach; the number box goes further for anything more extreme.
const SLIDER_MIN = -95;
const SLIDER_MAX = 300;
const fmtChange = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}%`;

// Weekly returns need a year at least; two years (104 weeks) is the common default for a
// published beta.
const LOOKBACKS = [
  { label: '1Y', days: 365 },
  { label: '2Y', days: 730 },
];

/**
 * One holding under the scenario, in log terms so it compounds rather than overshooting:
 *   centre  m = β · ln(1 + change)  [+ years · ln(1 + α) when alpha is switched on]
 *   spread  s = √( σβ² · ln(1 + change)² + σε² · weeks )
 * σβ is the uncertainty left in β after shrinkage and σε the holding's weekly swings that
 * the index doesn't explain, scaled to the length of the move. The holding's value is
 * multiplied by e^m, with e^(m ± s) bounding a one-standard-deviation (≈68%) range.
 */
function project(f, logChange, days, useAlpha) {
  const years = days / 365;
  const weeks = Math.max(days, 1) / 7;
  const alphaPart = useAlpha && f.alpha != null ? years * Math.log(Math.max(1 + f.alpha, 1e-6)) : 0;
  const m = f.beta * logChange + alphaPart;
  const s = Math.sqrt((f.beta_sd || 0) ** 2 * logChange ** 2 + (f.resid_sd || 0) ** 2 * weeks);
  return { m, s };
}

// Label at the outer end of a horizontal bar, past its error whisker: left of a negative
// bar, right of a positive one.
function BarEndLabel({ x, y, width, height, value, row }) {
  if (value == null) return null;
  const neg = value < 0;
  const flat = Math.abs(value) < 5e-4;
  const end = neg ? Math.min(x, x + width) : Math.max(x, x + width);
  let whisker = 0;
  if (row && Math.abs(value) > 1e-9) {
    const pxPerUnit = Math.abs(width) / Math.abs(value);
    whisker = (neg ? value - row.lo : row.hi - value) * pxPerUnit;
  }
  return (
    <text x={end + (neg ? -(whisker + 6) : whisker + 6)} y={y + height / 2} dy={4} textAnchor={neg ? 'end' : 'start'} fill={flat ? DIM : neg ? RED : GREEN} fontSize={12} fontWeight={600}>
      {fmtPct(value)}
    </text>
  );
}

function PortfolioTooltip({ active, payload, ccy }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ ...tooltipStyle, padding: '8px 10px', borderRadius: 6 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{p.name}</div>
      <div>Now: {fmtMoney(p.current, ccy)}</div>
      <div>After: {fmtMoney(p.stressed, ccy)}</div>
      <div className={cls(p.change)}>Change: {fmtMoney(p.change, ccy)} ({fmtPct(p.pct)})</div>
      <div style={{ color: DIM }}>Likely range: {fmtRange(p.lo, p.hi)}</div>
      <div style={{ color: DIM }}>Portfolio beta: {fmtNum(p.beta)}</div>
    </div>
  );
}

function HoldingTooltip({ active, payload, ccy }) {
  if (!active || !payload?.length) return null;
  const h = payload[0].payload;
  return (
    <div style={{ ...tooltipStyle, padding: '8px 10px', borderRadius: 6 }}>
      <div style={{ fontWeight: 600 }}>{h.label}</div>
      {h.display_name && h.display_name !== h.label && <div style={{ color: DIM, marginBottom: 4 }}>{h.display_name}</div>}
      <div>Now: {fmtMoney(h.current, ccy)}</div>
      <div>After: {fmtMoney(h.stressed, ccy)}</div>
      <div className={cls(h.pct)}>Change: {fmtMoney(h.stressed - h.current, ccy)} ({fmtPct(h.pct)})</div>
      {h.moves && <div style={{ color: DIM }}>Likely range: {fmtRange(h.lo, h.hi)}</div>}
      {h.moves && (
        <div style={{ color: DIM }}>
          β {fmtNum(h.beta)}{h.assumed ? ' (assumed)' : h.beta_raw != null && Math.abs(h.beta_raw - h.beta) >= 0.005 ? ` (measured ${fmtNum(h.beta_raw)})` : ''}
        </div>
      )}
    </div>
  );
}

/**
 * Hypothetical shock across every portfolio. A move in one US index, down or up, is pushed
 * through each holding's beta to that index — measured on weekly returns in the display
 * currency and shrunk toward 1 by its uncertainty — with a one-standard-deviation range
 * around each result.
 */
function HypotheticalShock() {
  const [lookback, setLookback] = useState(730);
  const [usIndex, setUsIndex] = useState('^GSPC');
  const [ccy, setCcy] = useState('USD');
  const [changePct, setChangePct] = useState(-20.5);
  const [durationDays, setDurationDays] = useState(1);
  const [scenario, setScenario] = useState('black-monday');
  // Off by default: a 2-year alpha is mostly noise (few holdings clear two standard errors)
  // and doesn't persist, so the projection assumes zero alpha unless asked.
  const [useAlpha, setUseAlpha] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  // Portfolios left out of the comparison. Tracked as exclusions so a newly created
  // portfolio shows up by default.
  const [hidden, setHidden] = useState(() => new Set());
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.stressInputs(lookback, usIndex, ccy)
      .then(d => { if (!cancelled) { setData(d); setErr(null); } })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [lookback, usIndex, ccy]);

  const applyScenario = s => {
    setScenario(s.key);
    setUsIndex(s.index);
    setChangePct(s.change);
    setDurationDays(s.days);
  };
  const editCustom = fn => v => { setScenario('custom'); fn(v); };

  // Signed index move as a fraction; a fall is capped short of −100% so its log stays defined.
  const change = Math.min(Math.max(Number(changePct) || 0, -99), 1000) / 100;
  const logChange = Math.log(1 + change);
  const days = Math.max(Number(durationDays) || 0, 0);

  // Apply the move to every holding, then roll up per portfolio. Lots of the same symbol
  // in different accounts are merged so each security is one bar; their uncertainty adds
  // in full (it's the same security), while different securities' uncertainties add in
  // quadrature (their non-market swings are independent once the index is accounted for).
  const results = useMemo(() => {
    if (!data) return [];
    const factors = data.factors || {};
    // A holding too new to measure gets the prior β and the widest measured swing.
    const widest = Math.max(0, ...Object.values(factors).map(f => f.resid_sd || 0));
    const STILL = { beta: 0, beta_sd: 0, resid_sd: 0, alpha: null, r2: null, beta_raw: null, assumed: false };
    return data.portfolios
      .filter(p => p.holdings.length > 0 && p.total > 0)
      .map(p => {
        const bySym = new Map();
        for (const h of p.holdings) {
          const f0 = factors[h.symbol];
          const f = h.is_cash
            ? (f0 || STILL)
            : f0?.assumed ? { ...f0, resid_sd: widest } : f0 || { beta: data.prior?.beta ?? 1, beta_sd: data.prior?.sd ?? 0.5, resid_sd: widest, alpha: null, assumed: true };
          const { m, s } = project(f, logChange, days, useAlpha);
          const key = h.is_cash ? `Cash ${h.currency}` : h.symbol;
          const row = bySym.get(key) || {
            label: key, symbol: h.symbol, display_name: h.is_cash ? 'Cash' : h.display_name, is_cash: h.is_cash,
            moves: !h.is_cash || !!f0, beta: f.beta, beta_raw: f.beta_raw ?? null, beta_sd: f.beta_sd, alpha: f.alpha ?? null,
            r2: f.r2 ?? null, assumed: !!f.assumed, m, s, current: 0, stressed: 0, sdValue: 0,
          };
          row.current += h.value;
          row.stressed += h.value * Math.exp(m);
          row.sdValue += h.value * Math.exp(m) * s;
          bySym.set(key, row);
        }
        const holdings = [...bySym.values()]
          .map(h => ({ ...h, pct: h.current > 0 ? h.stressed / h.current - 1 : 0, lo: Math.exp(h.m - h.s) - 1, hi: Math.exp(h.m + h.s) - 1 }))
          .sort((a, b) => b.current - a.current);
        const current = holdings.reduce((a, h) => a + h.current, 0);
        const stressed = holdings.reduce((a, h) => a + h.stressed, 0);
        const sd = Math.sqrt(holdings.reduce((a, h) => a + h.sdValue ** 2, 0));
        const pct = current > 0 ? stressed / current - 1 : 0;
        const { lo, hi } = bandOf(current, stressed, sd);
        const beta = current > 0 ? holdings.reduce((a, h) => a + h.beta * h.current, 0) / current : null;
        const sdBySym = new Map(holdings.map(h => [h.label, h.sdValue]));
        return { id: p.id, name: p.name, holdings, current, stressed, change: stressed - current, pct, lo, hi, err: [pct - lo, hi - pct], beta, sdBySym };
      });
  }, [data, logChange, days, useAlpha]);

  const shown = useMemo(() => results.filter(p => !hidden.has(p.id)), [results, hidden]);
  const nameById = useMemo(() => new Map(results.map(p => [p.id, p.name])), [results]);

  // Percent axis for the portfolio chart: a round tick step sized to the range (10% for a
  // crash, up to 1000% for a long boom), reaching past each whisker with ~10% of the width
  // spare for its label. The ends needn't land on a tick, so a small loss beside a big gain
  // doesn't drag in a whole extra step.
  const pctAxis = useMemo(() => {
    const lo = Math.min(0, ...shown.map(p => p.lo));
    const hi = Math.max(0, ...shown.map(p => p.hi));
    const pad = Math.max((hi - lo) * 0.12, 0.06);
    const min = lo < 0 ? lo - pad : 0;
    const max = hi > 0 ? hi + pad : 0;
    const step = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10].find(st => (max - min) / st <= 8) || 20;
    const ticks = [];
    for (let t = Math.ceil(min / step - 1e-9); t <= Math.floor(max / step + 1e-9); t++) ticks.push(t * step);
    return { domain: [min, max], ticks };
  }, [shown]);

  const selected = shown.find(p => p.id === selectedId) || shown[0] || null;

  // Combined total. A security held in two portfolios is one risk, so its uncertainty is
  // summed across them before the securities are combined in quadrature.
  const totals = useMemo(() => {
    const sdBySym = new Map();
    let current = 0, stressed = 0;
    for (const p of shown) {
      current += p.current;
      stressed += p.stressed;
      for (const [sym, sd] of p.sdBySym) sdBySym.set(sym, (sdBySym.get(sym) || 0) + sd);
    }
    const sd = Math.sqrt([...sdBySym.values()].reduce((a, v) => a + v * v, 0));
    return { current, stressed, ...bandOf(current, stressed, sd) };
  }, [shown]);

  const usName = data?.us_indexes?.find(i => i.symbol === usIndex)?.name || usIndex;
  const scenarioNote = SCENARIOS.find(s => s.key === scenario)?.note;
  const assumedCount = selected ? selected.holdings.filter(h => h.assumed).length : 0;
  // What the move implies for Korea, from KOSPI's and the won's own betas to the index.
  const kospiBeta = data?.implied?.kospi?.beta;
  const fxBeta = data?.implied?.krw_per_usd?.beta;
  const kospiMove = kospiBeta != null ? Math.exp(kospiBeta * logChange) - 1 : null;
  const wonMove = fxBeta != null ? Math.exp(-fxBeta * logChange) - 1 : null; // won's value in dollars
  const lookbackLabel = LOOKBACKS.find(l => l.days === lookback)?.label || `${lookback} days`;

  return (
    <div>
      <div className="panel">
        {/* Scenario presets, crashes then booms */}
        {SCENARIO_GROUPS.map(g => (
          <div key={g.kind} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ ...dimLabel, width: 56 }}>{g.label}</span>
            {SCENARIOS.filter(s => s.kind === g.kind).map(s => (
              <button key={s.key} className={`btn ${scenario === s.key ? '' : 'ghost'}`} onClick={() => applyScenario(s)} title={s.note}>
                {s.label} <span className={scenario === s.key ? '' : s.change < 0 ? 'down' : 'up'} style={{ opacity: 0.9 }}>{fmtChange(s.change)}</span>
              </button>
            ))}
            {g.kind === 'boom' && (
              <button className={`btn ${scenario === 'custom' ? '' : 'ghost'}`} onClick={() => setScenario('custom')}>Custom</button>
            )}
          </div>
        ))}

        {/* Size of the move: negative is a fall, positive a rise */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
          <span style={dimLabel}>Market change</span>
          <span style={{ ...dimLabel, fontSize: 11 }}>{SLIDER_MIN}%</span>
          <input
            type="range" min={SLIDER_MIN} max={SLIDER_MAX} step={0.5}
            value={Math.min(Math.max(Number(changePct) || 0, SLIDER_MIN), SLIDER_MAX)}
            onChange={e => editCustom(setChangePct)(Number(e.target.value))}
            list="stress-change-zero"
            style={{ flex: '1 1 240px', accentColor: ACCENT }}
          />
          <datalist id="stress-change-zero"><option value={0} /></datalist>
          <span style={{ ...dimLabel, fontSize: 11 }}>+{SLIDER_MAX}%</span>
          <input type="number" min={-99} max={1000} step={0.5} value={changePct} onChange={e => editCustom(setChangePct)(e.target.value)} style={inputStyle} />
          <span style={dimLabel}>%</span>
          <button className="btn ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => editCustom(setChangePct)(0)}>0</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <span style={dimLabel}>Index</span>
          {(data?.us_indexes || [{ symbol: '^GSPC', name: 'S&P 500' }, { symbol: '^IXIC', name: 'NASDAQ Composite' }]).map(i => (
            <button key={i.symbol} className={`btn ${usIndex === i.symbol ? '' : 'ghost'}`} onClick={() => editCustom(setUsIndex)(i.symbol)}>{i.name}</button>
          ))}

          <span style={{ ...dimLabel, marginLeft: 12 }}>Duration</span>
          <input type="number" min={0} max={3650} value={durationDays} onChange={e => editCustom(setDurationDays)(e.target.value)} style={inputStyle} />
          <span style={dimLabel}>days</span>

          <label style={{ ...dimLabel, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={useAlpha} onChange={e => setUseAlpha(e.target.checked)} /> Include alpha
          </label>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <span style={dimLabel}>Beta from weekly returns over</span>
          {LOOKBACKS.map(l => (
            <button key={l.label} className={`btn ${lookback === l.days ? '' : 'ghost'}`} onClick={() => setLookback(l.days)}>{l.label}</button>
          ))}
          <span style={{ ...dimLabel, marginLeft: 12 }}>Show in</span>
          {['USD', 'KRW'].map(c => (
            <button key={c} className={`btn ${ccy === c ? '' : 'ghost'}`} onClick={() => setCcy(c)}>{c}</button>
          ))}
        </div>

        <p style={{ margin: '14px 0 0', fontSize: 13, lineHeight: 1.6 }}>
          <span className={cls(change)} style={{ fontWeight: 600 }}>{usName} {fmtPct(change)}</span>
          {' '}over {days === 1 ? '1 day' : `${days} days`}
          {scenarioNote && <span style={{ color: 'var(--text-dim)' }}> · {scenarioNote}</span>}
          {kospiMove != null && Math.abs(change) > 0 && (
            <span style={{ color: 'var(--text-dim)' }}>
              <br />Implies KOSPI <span className={cls(kospiMove)}>{fmtPct(kospiMove)}</span>
              {wonMove != null && <> and the won <span className={cls(wonMove)}>{fmtPct(wonMove)}</span> against the dollar</>}
              , from how they've moved with the {usName} over the last {lookbackLabel}
            </span>
          )}
        </p>
      </div>

      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}

      {loading && !data ? (
        <div className="panel"><div className="loading">Measuring betas…</div></div>
      ) : results.length === 0 ? (
        <div className="panel"><div className="loading">No portfolios with priced holdings.</div></div>
      ) : (
        <>
          {/* All portfolios */}
          <div className="panel" style={{ opacity: loading ? 0.6 : 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
              <h2 style={{ margin: 0 }}>Portfolios after the {change >= 0 ? 'rise' : 'fall'}</h2>
              <div style={{ fontSize: 13, textAlign: 'right' }}>
                {shown.length === results.length ? 'All portfolios' : `${shown.length} of ${results.length} portfolios`}: {fmtMoney(totals.current, ccy)} → <span style={{ fontWeight: 600 }}>{fmtMoney(totals.stressed, ccy)}</span>{' '}
                <span className={cls(totals.stressed - totals.current)}>
                  ({fmtMoney(totals.stressed - totals.current, ccy)}, {fmtPct(totals.current > 0 ? totals.stressed / totals.current - 1 : 0)})
                </span>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>likely range {fmtRange(totals.lo, totals.hi)}</div>
              </div>
            </div>
            {/* Which portfolios to compare */}
            <PortfolioChips portfolios={results} hidden={hidden} setHidden={setHidden} />

            {shown.length === 0 ? (
              <div className="loading">No portfolios selected. Pick one or more above.</div>
            ) : (
            <>
            <div style={{ width: '100%', height: Math.max(160, shown.length * 44 + 40), marginTop: 12 }}>
              <ResponsiveContainer>
                <BarChart data={shown} layout="vertical" margin={{ top: 4, right: 40, left: 10, bottom: 4 }}
                  onClick={e => { const id = e?.activePayload?.[0]?.payload?.id; if (id != null) setSelectedId(id); }}>
                  <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" dataKey="pct" stroke={DIM} fontSize={11} tickFormatter={v => `${(Math.round(v * 100) || 0).toLocaleString()}%`} domain={pctAxis.domain} ticks={pctAxis.ticks} />
                  <YAxis type="category" dataKey="id" stroke={DIM} width={120} interval={0}
                    tick={<PortfolioTick nameById={nameById} onOpen={id => navigate(`/portfolios/${id}`)} />} />
                  <ReferenceLine x={0} stroke={DIM} />
                  <Tooltip content={<PortfolioTooltip ccy={ccy} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                  <Bar dataKey="pct" fill={ACCENT} radius={2} maxBarSize={28} style={{ cursor: 'pointer' }}>
                    {shown.map(p => (
                      <Cell key={p.id} fill={ACCENT} fillOpacity={selected?.id === p.id ? 1 : DIMMED_OPACITY} />
                    ))}
                    <ErrorBar dataKey="err" direction="x" width={6} strokeWidth={1.5} stroke={WHISKER} />
                    <LabelList dataKey="pct" content={props => <BarEndLabel {...props} row={shown[props.index]} />} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Portfolio</th>
                  <th className="num" title="Value-weighted beta to the index. Cash in another currency counts through its exchange rate">Beta</th>
                  <th className="num">Now</th>
                  <th className="num">After</th>
                  <th className="num">Change</th>
                  <th className="num">%</th>
                  <th className="num" title="One standard deviation either side: about a 2-in-3 chance the result lands here">Likely range</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(p => (
                  <tr key={p.id} onClick={() => setSelectedId(p.id)} style={{ cursor: 'pointer', background: selected?.id === p.id ? 'var(--panel-2)' : undefined }}>
                    <td><Link to={`/portfolios/${p.id}`} onClick={e => e.stopPropagation()}>{p.name}</Link></td>
                    <td className="num">{fmtNum(p.beta)}</td>
                    <td className="num">{fmtMoney(p.current, ccy)}</td>
                    <td className="num">{fmtMoney(p.stressed, ccy)}</td>
                    <td className={`num ${cls(p.change)}`}>{fmtMoney(p.change, ccy)}</td>
                    <td className={`num ${cls(p.pct)}`}>{fmtPct(p.pct)}</td>
                    <td className="num" style={{ color: 'var(--text-dim)' }}>{fmtRange(p.lo, p.hi)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </>
            )}
          </div>

          {/* One portfolio, by holding */}
          {selected && (
            <div className="panel" style={{ opacity: loading ? 0.6 : 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <h2 style={{ margin: 0 }}><Link to={`/portfolios/${selected.id}`}>{selected.name}</Link> by holding</h2>
                <select value={selected.id} onChange={e => setSelectedId(Number(e.target.value))} style={{ ...inputStyle, width: 'auto' }}>
                  {shown.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div style={{ width: '100%', height: Math.max(180, selected.holdings.length * 34 + 60), marginTop: 12 }}>
                <ResponsiveContainer>
                  <BarChart data={selected.holdings} layout="vertical" margin={{ top: 4, right: 70, left: 10, bottom: 4 }} barGap={1}>
                    <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" stroke={DIM} fontSize={11} tickFormatter={v => fmtCompact(v, ccy)} />
                    <YAxis type="category" dataKey="label" stroke={DIM} fontSize={11} width={110} interval={0} />
                    <Tooltip content={<HoldingTooltip ccy={ccy} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="current" name="Now" fill={BASELINE} fillOpacity={BASELINE_OPACITY} radius={2} />
                    <Bar dataKey="stressed" name={`After the ${change >= 0 ? 'rise' : 'fall'}`} fill={ACCENT} radius={2}>
                      <LabelList dataKey="pct" content={HoldingPctLabel} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <table style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Holding</th>
                    <th className="num" title={`Sensitivity to the ${usName}: 1.5 means it moves about 1.5% for each 1% move in the index. Shrunk toward 1 by how uncertain the estimate is; hover a value for the raw estimate`}>Beta</th>
                    <th className="num" title="Annualized alpha: return beyond what beta explains. Only used when Include alpha is ticked">Alpha /yr</th>
                    <th className="num" title="Share of the holding's weekly moves the index explains. Low R² = the index is a weak guide to this holding, so its range is wide">R²</th>
                    <th className="num">Now</th>
                    <th className="num">After</th>
                    <th className="num">%</th>
                    <th className="num" title="One standard deviation either side: about a 2-in-3 chance the result lands here">Likely range</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.holdings.map(h => (
                    <tr key={h.label}>
                      <td>
                        {h.is_cash ? h.label : <Link to={`/instruments/${encodeURIComponent(h.symbol)}`}>{h.label}</Link>}
                        {!h.is_cash && h.display_name && (
                          <div style={{ fontSize: 11, color: 'var(--text-dim)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.display_name}</div>
                        )}
                        {h.is_cash && h.moves && (
                          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>moves with the exchange rate</div>
                        )}
                      </td>
                      <td className="num" title={h.beta_raw != null ? `Measured ${fmtNum(h.beta_raw)} ± ${fmtNum(h.beta_sd)} before shrinkage` : undefined}>
                        {h.assumed
                          ? <span className="pill amber" title="Too little history to measure; uses the typical stock's beta of 1.00">{fmtNum(h.beta)}*</span>
                          : fmtNum(h.beta)}
                      </td>
                      <td className={`num ${useAlpha ? cls(h.alpha) : ''}`} style={useAlpha ? undefined : { color: 'var(--text-dim)' }}>{h.is_cash ? '–' : fmtPct(h.alpha)}</td>
                      <td className="num" style={{ color: h.r2 != null && h.r2 < 0.2 ? 'var(--amber)' : undefined }}>{h.r2 == null ? '–' : fmtNum(h.r2)}</td>
                      <td className="num">{fmtMoney(h.current, ccy)}</td>
                      <td className="num">{fmtMoney(h.stressed, ccy)}</td>
                      <td className={`num ${cls(h.pct)}`}>{fmtPct(h.pct)}</td>
                      <td className="num" style={{ color: 'var(--text-dim)' }}>{h.moves ? fmtRange(h.lo, h.hi) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {assumedCount > 0 && (
                <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--amber)' }}>
                  * {assumedCount} holding{assumedCount > 1 ? 's' : ''} with too little history to measure (under 26 weeks); given the typical stock's beta of 1.00 and a wide range.
                </p>
              )}
            </div>
          )}

          <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: '0 4px' }}>
            <p style={{ margin: '0 0 6px' }}>
              <strong style={{ color: 'var(--text)' }}>How this is estimated.</strong>{' '}
              Each holding's beta is its sensitivity to the {usName}, measured from weekly returns over the last {lookbackLabel} — the usual basis for a published beta, and one that
              isn't thrown off by Seoul and New York closing at different hours. Returns are measured in {ccy}, so the exchange-rate move that tends to come with a market move is
              included: a Korean stock or won cash seen in dollars carries the won's tendency to weaken in a sell-off. Korean holdings are measured against the {usName} directly,
              which is what a move in that index implies for them, rather than assuming KOSPI moves by the same amount.
            </p>
            <p style={{ margin: '0 0 6px' }}>
              Every beta is then shrunk toward 1, the average stock's, in proportion to how uncertain it is (the Vasicek adjustment): a tightly measured index fund keeps its own
              value while a short or erratic history leans on the average. Holdings move by (1 + change)<sup>β</sup>, which matches β × change for small moves and can't fall
              past −100% in a deep one. Alpha is assumed to be zero — past outperformance over a couple of years is mostly noise — unless Include alpha is ticked.
            </p>
            <p style={{ margin: 0 }}>
              The likely range is one standard deviation either side, about a 2-in-3 chance, combining the uncertainty in each beta with the holding's own swings that the index
              doesn't explain, over the length of the move; a low R² (amber) means a wide range. It assumes those swings are independent between holdings. The model can't
              capture stocks moving together more tightly in a crash than in calm markets, which tends to make real crash losses somewhat worse than this.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

const MODES = [
  { key: 'replay', label: 'Historical replay', hint: 'Run today\'s holdings through what actually happened in a past crash or boom' },
  { key: 'shock', label: 'Hypothetical shock', hint: 'Pick any size of market move and see what each holding\'s beta implies' },
];

/** The stress test page: a historical replay or a hypothetical shock, over every portfolio. */
export default function StressTest() {
  const [mode, setMode] = useState('replay');
  return (
    <div>
      <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, padding: '14px 20px' }}>
        <h2 style={{ margin: 0 }}>Market Stress Test</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="tablist">
          {MODES.map(m => (
            <button key={m.key} role="tab" aria-selected={mode === m.key} title={m.hint}
              className={`btn ${mode === m.key ? '' : 'ghost'}`} onClick={() => setMode(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {mode === 'replay' ? <HistoricalReplay /> : <HypotheticalShock />}
    </div>
  );
}
