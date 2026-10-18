import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend,
} from 'recharts';
import { api } from '../api.js';
import { historyStats, combineHistory, MIN_PATHS } from '../projection/simulate.js';
import { DIM, ACCENT, BASELINE, tooltipStyle, inputStyle, dimLabel, chipStyle, fmtMoney, fmtCompact } from './stressShared.jsx';

const PATH_OPTIONS = [MIN_PATHS, 25000, 50000, 100000];
const MODELS = [
  { key: 'historical', label: 'Historical blocks', hint: "12-month runs of your holdings' own history since 2000, rescaled to the return and volatility below: keeps real crashes and fat tails" },
  { key: 'normal', label: 'Normal', hint: 'Independent log-normal monthly returns with the return and volatility below' },
];
const STRATEGIES = [
  { key: 'fixed', label: 'Fixed, inflation-adjusted', hint: 'Spend the same amount in today\'s money every year: the amount rises with inflation' },
  { key: 'percent', label: '% of balance', hint: 'Spend the withdrawal rate × the balance at the start of each year: never runs out, but spending moves with the market' },
];

// Starting assumptions, in won (the page opens in KRW).
const DEFAULTS = {
  other: 400_000_000,       // assets outside the tracked portfolios
  spending: 54_000_000,     // ₩4.5M a month, today's money
  income: 40_000_000,       // National Pension, today's money
  incomeStart: '15',        // years from now
  // Korea's official CPI averaged about 2.5% a year 2000–2023 but hit 5.1% in 2022, and a
  // household's own costs (food, rent, health care) rise faster than the index.
  inflation: '4.0',
  inflationVol: '1.5',
  cashSpread: '0.5',
  otherRate: '5.0',         // other assets: a steady return a year, before inflation        // a savings account: a little above inflation
  // Default return on the invested part: cash's rate plus this much per unit of volatility
  // (a Sharpe ratio). Long-run equity Sharpe ratios run about 0.25–0.4; the low end is used
  // because 2000–2026 history, which strong US tech returns lifted, is above what major
  // managers' long-run forecasts expect from here.
  sharpe: 0.25,
};

const fmtPctPlain = (n, d = 1) => {
  if (n == null || isNaN(n)) return '–';
  // A handful of paths shouldn't read as none (or as all).
  const unit = 10 ** -(d + 2);
  if (n > 0 && n < unit) return `<${(unit * 100).toFixed(d)}%`;
  if (n < 1 && n > 1 - unit) return `>${(100 - unit * 100).toFixed(d)}%`;
  return `${(n * 100).toFixed(d)}%`;
};
const num = v => { const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

// Amount input that shows thousands separators and keeps whatever the user is typing.
function MoneyInput({ value, onChange, ccy, width = 150 }) {
  const [text, setText] = useState(() => Math.round(value).toLocaleString());
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(Math.round(value).toLocaleString()); }, [value]);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={dimLabel}>{ccy === 'KRW' ? '₩' : '$'}</span>
      <input
        type="text" inputMode="numeric" value={text} style={{ ...inputStyle, width }}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; setText(Math.round(value).toLocaleString()); }}
        onChange={e => { setText(e.target.value); onChange(Math.max(0, num(e.target.value))); }}
      />
    </span>
  );
}

function PctInput({ value, onChange, step = 0.1, min = -50, max = 100 }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input type="number" step={step} min={min} max={max} value={value} onChange={e => onChange(e.target.value)} style={inputStyle} />
      <span style={dimLabel}>%</span>
    </span>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={dimLabel} title={hint}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function Metric({ label, value, sub, title }) {
  return (
    <div className="panel" style={{ marginBottom: 0 }} title={title}>
      <div className="metric-label">{label}</div>
      <div className="metric" style={{ marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function FanTip({ active, payload, ccy }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const row = (label, v, strong) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontWeight: strong ? 600 : 400 }}>
      <span style={{ color: strong ? ACCENT : DIM }}>{label}</span><span>{fmtMoney(v, ccy)}</span>
    </div>
  );
  return (
    <div style={{ ...tooltipStyle, padding: '8px 10px', borderRadius: 6, minWidth: 220 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Year {d.year}</div>
      {row('Good (1 in 20)', d.p95)}
      {row('75th percentile', d.p75)}
      {row('Median', d.p50, true)}
      {row('25th percentile', d.p25)}
      {row('Bad (1 in 20)', d.p5)}
      {d.out > 0 && <div style={{ color: 'var(--amber)', marginTop: 4 }}>Run out by now: {fmtPctPlain(d.out)}</div>}
    </div>
  );
}

/**
 * Portfolio projection: a Monte Carlo simulation of the chosen portfolios' value over the
 * years ahead, with inflation-adjusted spending (or a withdrawal rate), a pension or
 * other income, and random inflation. The engine is projection/simulate.js, run in a
 * worker; the backend supplies today's values and the holdings' monthly history since
 * 2000 for the historical-blocks model and the default return and volatility.
 */
export default function Projection() {
  const [ccy, setCcy] = useState('KRW');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(null); // Set of portfolio ids
  const [other, setOther] = useState(DEFAULTS.other);
  const [model, setModel] = useState('historical');
  const [mean, setMean] = useState('');
  // The return follows its default (which moves with inflation and the cash rate) until
  // it is typed over or set to history.
  const [meanFollows, setMeanFollows] = useState(true);
  const [vol, setVol] = useState('');
  const [inflation, setInflation] = useState(DEFAULTS.inflation);
  const [inflationVol, setInflationVol] = useState(DEFAULTS.inflationVol);
  const [cashSpread, setCashSpread] = useState(DEFAULTS.cashSpread);
  const [otherRate, setOtherRate] = useState(DEFAULTS.otherRate);
  const [strategy, setStrategy] = useState('fixed');
  const [spending, setSpending] = useState(DEFAULTS.spending); // per year, today's money
  const [income, setIncome] = useState(DEFAULTS.income);
  const [incomeStart, setIncomeStart] = useState(DEFAULTS.incomeStart);
  const [years, setYears] = useState('30');
  const [paths, setPaths] = useState(MIN_PATHS);
  const [seed, setSeed] = useState(1);
  const [view, setView] = useState('real');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [simErr, setSimErr] = useState(null);
  const workerRef = useRef(null);
  const runId = useRef(0);
  const prevCcy = useRef(ccy);

  useEffect(() => {
    let cancelled = false;
    api.projectionInputs(ccy)
      .then(d => {
        if (cancelled) return;
        // Amounts typed in the other currency are carried across at today's rate.
        if (prevCcy.current !== ccy && d.krw_per_usd) {
          const k = ccy === 'KRW' ? d.krw_per_usd : 1 / d.krw_per_usd;
          setOther(v => v * k);
          setSpending(v => (v == null ? v : v * k));
          setIncome(v => v * k);
        }
        prevCcy.current = ccy;
        setData(d);
        setErr(null);
        setSelected(s => s || new Set(d.portfolios.length ? [d.portfolios[0].id] : []));
      })
      .catch(e => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [ccy]);

  const chosen = useMemo(() => (data && selected ? data.portfolios.filter(p => selected.has(p.id)) : []), [data, selected]);
  const tracked = chosen.reduce((a, p) => a + p.value, 0);
  const start = tracked + other;
  // Three parts of the balance: the portfolios' cash, other assets at their own steady
  // rate, and the portfolios' investments.
  const cashValue = chosen.reduce((a, p) => a + p.cash, 0);
  const cashShare = start > 0 ? cashValue / start : 0;
  const otherShare = start > 0 ? other / start : 0;
  const investedShare = Math.max(0, 1 - cashShare - otherShare);
  const withInvested = useMemo(() => chosen.filter(p => p.monthly.length > 0 && p.value > p.cash), [chosen]);
  const history = useMemo(() => combineHistory(withInvested.map(p => p.monthly), withInvested.map(p => p.value - p.cash)), [withInvested]);
  const hist = useMemo(() => historyStats(history), [history]);
  const cashRate = (1 + num(inflation) / 100) * (1 + num(cashSpread) / 100) - 1;

  // Return and volatility once the history is in: the default return, history's volatility.
  const defaultMean = hist ? ((cashRate + DEFAULTS.sharpe * hist.vol) * 100).toFixed(1) : '';
  const useDefaults = () => { setMeanFollows(true); setVol((hist.vol * 100).toFixed(1)); };
  useEffect(() => {
    if (meanFollows && defaultMean !== '') setMean(defaultMean);
  }, [meanFollows, defaultMean]);
  useEffect(() => {
    if (hist && vol === '') setVol((hist.vol * 100).toFixed(1));
  }, [hist]); // eslint-disable-line react-hooks/exhaustive-deps

  const rate = start > 0 && spending != null ? spending / start : 0;
  const H = Math.min(60, Math.max(1, Math.round(num(years)) || 30));

  const params = useMemo(() => {
    if (!(start > 0) || spending == null || mean === '' || vol === '') return null;
    return {
      start, years: H, paths, seed, model, history,
      mean: num(mean) / 100, vol: Math.max(0, num(vol)) / 100,
      inflation: num(inflation) / 100, inflationVol: Math.max(0, num(inflationVol)) / 100,
      strategy, spending, rate, income, incomeStart: Math.max(0, num(incomeStart)),
      cashShare, cashSpread: num(cashSpread) / 100, otherShare, otherRate: num(otherRate) / 100,
    };
  }, [start, H, paths, seed, model, history, mean, vol, inflation, inflationVol, strategy, spending, rate, income, incomeStart, cashShare, cashSpread, otherShare, otherRate]);
  // The whole balance's expected return: invested part and cash, by weight.
  const blended = investedShare * (num(mean) / 100) + cashShare * cashRate + otherShare * (num(otherRate) / 100);

  // Debounced run in the worker; only the latest request's answer is kept.
  useEffect(() => {
    if (!params) return;
    if (!workerRef.current) {
      workerRef.current = new Worker(new URL('../projection/worker.js', import.meta.url), { type: 'module' });
    }
    const w = workerRef.current;
    const id = ++runId.current;
    const timer = setTimeout(() => {
      setRunning(true);
      w.onmessage = e => {
        if (e.data.id !== runId.current) return;
        setRunning(false);
        if (e.data.error) setSimErr(e.data.error);
        else { setResult(e.data.result); setSimErr(null); }
      };
      w.postMessage({ id, params });
    }, 250);
    return () => clearTimeout(timer);
  }, [params]);
  useEffect(() => () => workerRef.current?.terminate(), []);

  const toggle = id => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const bandsKey = view === 'real' ? 'real' : 'nominal';
  const chartRows = useMemo(() => (result ? result[bandsKey].map((b, y) => ({
    year: y, ...b, outer: [b.p5, b.p95], inner: [b.p25, b.p75], out: result.ranOutBy[y],
  })) : []), [result, bandsKey]);
  const checkpoints = useMemo(() => {
    if (!result) return [];
    const ys = new Set([1]);
    for (let y = 5; y < result.years; y += 5) ys.add(y);
    ys.add(result.years);
    return [...ys].filter(y => y <= result.years).sort((a, b) => a - b);
  }, [result]);

  const end = result ? result[bandsKey][result.years] : null;
  const endReal = result ? result.real[result.years] : null;
  const perMonth = v => `${fmtCompact(v / 12, ccy)} / month`;
  const netDraw = spending != null ? spending - income : 0;

  return (
    <div>
      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}
      {!data ? (
        !err && <div className="panel"><div className="loading">Loading your portfolios and their history since 2000…</div></div>
      ) : (
        <>
          <div className="panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
              <h2 style={{ margin: 0 }}>Portfolio projection</h2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={dimLabel}>Show in</span>
                {['KRW', 'USD'].map(c => (
                  <button key={c} className={`btn ${ccy === c ? '' : 'ghost'}`} onClick={() => setCcy(c)}>{c}</button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 14 }}>
              <span style={{ ...dimLabel, marginRight: 4 }}>Portfolios</span>
              {data.portfolios.map(p => {
                const on = selected?.has(p.id);
                return (
                  <button key={p.id} className={`btn ${on ? '' : 'ghost'}`} style={chipStyle} aria-pressed={on} onClick={() => toggle(p.id)}
                    title={fmtMoney(p.value, ccy)}>
                    {p.name}
                  </button>
                );
              })}
            </div>

            <div className="grid-5" style={{ marginTop: 16, alignItems: 'start' }}>
              <Field label="Other assets" hint="Money outside these portfolios (for example a spouse's savings)">
                <MoneyInput value={other} onChange={setOther} ccy={ccy} />
              </Field>
              <Field label="Return on other assets (per year)" hint="A steady return, before inflation, with no ups and downs (deposits, bonds held to maturity)">
                <PctInput value={otherRate} onChange={setOtherRate} min={-10} max={30} />
                {other > 0 && <span style={dimLabel}>{fmtPctPlain(otherShare)} of the balance</span>}
              </Field>
              <Field label="Starting balance">
                <span style={{ fontSize: 18, fontWeight: 600 }}>{fmtMoney(start, ccy)}</span>
                {chosen.length > 0 && other > 0 && <span style={dimLabel}>{fmtCompact(tracked, ccy)} + {fmtCompact(other, ccy)}</span>}
              </Field>
              <Field label="Years">
                <input type="number" min={1} max={60} value={years} onChange={e => setYears(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Simulations" hint="Number of random paths; more paths make the percentiles steadier">
                {PATH_OPTIONS.map(n => (
                  <button key={n} className={`btn ${paths === n ? '' : 'ghost'}`} style={chipStyle} onClick={() => setPaths(n)}>{n.toLocaleString()}</button>
                ))}
              </Field>
            </div>
          </div>

          <div className="panel">
            <h2>Assumptions</h2>
            <div className="grid-3" style={{ alignItems: 'start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Field label={cashShare > 0 ? 'Rate of return on investments (average per year)' : 'Rate of return (average per year)'}
                  hint={`Expected annual return before inflation, in ${ccy}${cashShare > 0 ? `, for everything except ${ccy} cash` : ''}`}>
                  <PctInput value={mean} onChange={v => { setMeanFollows(false); setMean(v); }} />
                </Field>
                <Field label="Volatility (per year)" hint="Standard deviation of annual returns of the investments">
                  <PctInput value={vol} onChange={setVol} min={0} />
                </Field>
                {hist && (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                    History of {cashShare > 0 ? 'these investments' : "today's mix"}, {data.months[0]?.slice(0, 4)}–{data.history_to?.slice(0, 4)}:{' '}
                    {fmtPctPlain(hist.mean)} average ({fmtPctPlain(hist.compound)} compound), {fmtPctPlain(hist.vol)} volatility.
                    {' '}Default: cash's rate + {DEFAULTS.sharpe} × volatility, a cautious long-run reward for risk, since that period favoured these holdings.{' '}
                    <span style={{ display: 'inline-flex', gap: 6, marginTop: 4 }}>
                      <button className="btn ghost" style={{ ...chipStyle, padding: '1px 8px' }} onClick={useDefaults}>Default ({defaultMean}%)</button>
                      <button className="btn ghost" style={{ ...chipStyle, padding: '1px 8px' }}
                        onClick={() => { setMeanFollows(false); setMean((hist.mean * 100).toFixed(1)); setVol((hist.vol * 100).toFixed(1)); }}>History ({(hist.mean * 100).toFixed(1)}%)</button>
                    </span>
                  </div>
                )}
                {cashShare > 0 && (
                  <Field label={`${ccy} cash earns (above inflation)`} hint="Savings-account rate over inflation; cash keeps pace with each path's inflation plus this">
                    <PctInput value={cashSpread} onChange={setCashSpread} min={-5} max={10} />
                    <span style={dimLabel}>{fmtPctPlain(cashShare)} of the balance · {fmtPctPlain(cashRate)} a year</span>
                  </Field>
                )}
                {(cashShare > 0 || other > 0) && mean !== '' && (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                    Investments {fmtPctPlain(investedShare)} · cash {fmtPctPlain(cashShare)} · other {fmtPctPlain(otherShare)}.
                    {' '}Whole balance: about <span style={{ color: 'var(--text)', fontWeight: 600 }}>{fmtPctPlain(blended)}</span> a year on average
                    ({fmtPctPlain((1 + blended) / (1 + num(inflation) / 100) - 1)} above inflation).
                  </div>
                )}
                <Field label="Return model">
                  {MODELS.map(m => (
                    <button key={m.key} className={`btn ${model === m.key ? '' : 'ghost'}`} style={chipStyle} title={m.hint} onClick={() => setModel(m.key)}>{m.label}</button>
                  ))}
                </Field>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Field label="Rate of inflation (average per year)">
                  <PctInput value={inflation} onChange={setInflation} min={-5} max={30} />
                </Field>
                <Field label="Inflation variability (± per year)" hint="Year-to-year standard deviation of inflation; 0 for a steady rate">
                  <PctInput value={inflationVol} onChange={setInflationVol} min={0} max={20} />
                </Field>
                <Field label="Pension / other income per year (today's money)" hint="Raised with inflation each year, like spending">
                  <MoneyInput value={income} onChange={setIncome} ccy={ccy} />
                </Field>
                <Field label="Income starts after">
                  <input type="number" min={0} max={60} value={incomeStart} onChange={e => setIncomeStart(e.target.value)} style={inputStyle} />
                  <span style={dimLabel}>years{income > 0 ? ` · ${perMonth(income)}` : ''}</span>
                </Field>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Field label="Spending rule">
                  {STRATEGIES.map(s => (
                    <button key={s.key} className={`btn ${strategy === s.key ? '' : 'ghost'}`} style={chipStyle} title={s.hint} onClick={() => setStrategy(s.key)}>{s.label}</button>
                  ))}
                </Field>
                <Field label={strategy === 'fixed' ? 'Inflation-adjusted spending per year (today\'s money)' : 'First-year spending'}>
                  <MoneyInput value={spending ?? 0} onChange={setSpending} ccy={ccy} />
                  <span style={dimLabel}>{perMonth(spending ?? 0)}</span>
                </Field>
                <Field label={strategy === 'fixed' ? 'Withdrawal rate (first year ÷ starting balance)' : 'Withdrawal rate (of each year\'s balance)'}>
                  <PctInput value={(rate * 100).toFixed(2)} step={0.1} min={0} max={100}
                    onChange={v => setSpending(Math.max(0, num(v)) / 100 * start)} />
                </Field>
                {strategy === 'fixed' && income > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                    Once income starts, the portfolio pays {netDraw > 0 ? `${fmtCompact(netDraw, ccy)} a year (${fmtPctPlain(start > 0 ? netDraw / start : 0, 2)} of today's balance)` : 'nothing; income covers spending'}.
                  </div>
                )}
              </div>
            </div>
          </div>

          {simErr && <div className="error" style={{ marginBottom: 16 }}>{simErr}</div>}
          {chosen.length === 0 && other <= 0 ? (
            <div className="panel"><div className="loading">Pick a portfolio or enter other assets to project.</div></div>
          ) : !result ? (
            <div className="panel"><div className="loading">Simulating {paths.toLocaleString()} paths…</div></div>
          ) : (
            <div style={{ opacity: running ? 0.6 : 1, transition: 'opacity .15s' }}>
              <div className="grid-5" style={{ marginBottom: 16 }}>
                {result.strategy === 'fixed' ? (
                  <Metric label={`Lasts ${result.years} years`} value={fmtPctPlain(result.success)}
                    sub={result.firstRunOut ? `${result.firstRunOut.count.toLocaleString()} of ${result.paths.toLocaleString()} paths run out, typically in year ${Math.ceil(result.firstRunOut.p50)}` : 'No path ran out'}
                    title="Share of paths that never run out of money" />
                ) : (
                  <Metric label={`Spending in year ${result.years}`} value={fmtCompact(result.spending[result.years - 1].p50, ccy)}
                    sub={`Bad case ${fmtCompact(result.spending[result.years - 1].p5, ccy)} a year, today's money`}
                    title="Median yearly spending in the final year under the percent rule, in today's money" />
                )}
                <Metric label="Keeps today's value" value={fmtPctPlain(result.keepStart)}
                  sub={`Ends above ${fmtCompact(start, ccy)} in today's money`} />
                <Metric label={`Median, year ${result.years}`} value={fmtCompact(endReal.p50, ccy)} sub="Today's money" />
                <Metric label={`Bad case, year ${result.years}`} value={fmtCompact(endReal.p5, ccy)} sub="1 in 20 ends lower · today's money" />
                <Metric label="Most you could spend" value={fmtCompact(result.safeSpending.lasts90, ccy)}
                  sub={`a year (${perMonth(result.safeSpending.lasts90)}) and still last ${result.years} years in 9 of 10 paths`}
                  title="Highest fixed inflation-adjusted spending at which 90% of paths never run out, with the same income" />
              </div>

              <div className="panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
                  <h2 style={{ margin: 0 }}>Balance over time</h2>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ ...dimLabel, fontSize: 11 }}>{result.paths.toLocaleString()} paths · {(result.ms / 1000).toFixed(1)}s</span>
                    <button className="btn ghost" style={chipStyle} title="Run again with new random numbers" onClick={() => setSeed(s => s + 1)}>Re-run</button>
                    {[['real', "Today's money"], ['nominal', 'Future money']].map(([k, label]) => (
                      <button key={k} className={`btn ${view === k ? '' : 'ghost'}`} style={chipStyle} onClick={() => setView(k)}>{label}</button>
                    ))}
                  </div>
                </div>
                <div style={{ width: '100%', height: 360, marginTop: 12 }}>
                  <ResponsiveContainer>
                    <ComposedChart data={chartRows} margin={{ top: 8, right: 16, left: 10, bottom: 4 }}>
                      <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
                      <XAxis dataKey="year" stroke={DIM} fontSize={11} tickFormatter={y => `${y}y`} />
                      <YAxis stroke={DIM} fontSize={11} width={70} tickFormatter={v => fmtCompact(v, ccy)} />
                      <Tooltip content={<FanTip ccy={ccy} />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <ReferenceLine y={start} stroke={BASELINE} strokeDasharray="4 4" label={{ value: 'Start', fill: DIM, fontSize: 11, position: 'insideTopLeft' }} />
                      {income > 0 && num(incomeStart) > 0 && num(incomeStart) < result.years && (
                        <ReferenceLine x={Math.round(num(incomeStart))} stroke={BASELINE} strokeDasharray="2 4"
                          label={{ value: 'Income starts', fill: DIM, fontSize: 11, position: 'insideTopRight' }} />
                      )}
                      <Area dataKey="outer" name="5–95% of paths" stroke="none" fill={ACCENT} fillOpacity={0.14} isAnimationActive={false} />
                      <Area dataKey="inner" name="25–75%" stroke="none" fill={ACCENT} fillOpacity={0.28} isAnimationActive={false} />
                      <Line dataKey="p50" name="Median" stroke={ACCENT} strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line dataKey="p5" name="Bad case (1 in 20)" stroke={BASELINE} strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <table style={{ marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th className="num" title="5th percentile: 1 path in 20 ends lower">Bad (1 in 20)</th>
                      <th className="num">25th</th>
                      <th className="num">Median</th>
                      <th className="num">75th</th>
                      <th className="num" title="95th percentile: 1 path in 20 ends higher">Good (1 in 20)</th>
                      {result.strategy === 'percent'
                        ? <th className="num" title="Median spending that year, in today's money">Spending (median)</th>
                        : <th className="num">Run out by then</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {checkpoints.map(y => {
                      const b = result[bandsKey][y];
                      return (
                        <tr key={y}>
                          <td>{y}</td>
                          <td className="num">{fmtMoney(b.p5, ccy)}</td>
                          <td className="num">{fmtMoney(b.p25, ccy)}</td>
                          <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(b.p50, ccy)}</td>
                          <td className="num">{fmtMoney(b.p75, ccy)}</td>
                          <td className="num">{fmtMoney(b.p95, ccy)}</td>
                          {result.strategy === 'percent'
                            ? <td className="num">{fmtMoney(result.spending[y - 1].p50, ccy)}</td>
                            : <td className="num" style={{ color: result.ranOutBy[y] > 0 ? 'var(--amber)' : undefined }}>{fmtPctPlain(result.ranOutBy[y])}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                  Keep {fmtCompact(start, ccy)} in today's money with 90% confidence: spend up to {fmtCompact(result.safeSpending.keeps90, ccy)} a year
                  ({perMonth(result.safeSpending.keeps90)}); with 75%: {fmtCompact(result.safeSpending.keeps75, ccy)} a year.
                  {' '}Lasting {result.years} years with 95% confidence: up to {fmtCompact(result.safeSpending.lasts95, ccy)} a year.
                  {view === 'nominal' && end && <> Future money at year {result.years} includes inflation; the median path's prices are about {(endReal.p50 > 0 ? end.p50 / endReal.p50 : 0).toFixed(2)}× today's.</>}
                </p>
              </div>

              <div className="panel" style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--text)' }}>How it works.</strong> Each of the {result.paths.toLocaleString()} paths runs month by month:
                spending is withdrawn (raised by that path's inflation so far), income is added once it starts, then the balance earns a random return.
                {model === 'historical'
                  ? <> Returns are 12-month blocks drawn at random from what today's holdings would have done since {data.months[0]} (each following its proxy index at today's beta, as in the <Link to="/stress">historical replay</Link>), rescaled to the return and volatility above.</>
                  : <> Returns are independent and log-normal with the return and volatility above.</>}
                {cashShare > 0 && <> {ccy} cash ({fmtPctPlain(cashShare)} of the balance) earns each path's inflation plus the margin above.</>}
                {other > 0 && <> Other assets ({fmtPctPlain(otherShare)}) earn a steady {fmtPctPlain(num(otherRate) / 100)} a year.</>}
                {' '}The three parts are rebalanced monthly.
                {' '}Inflation is drawn for each year around the rate above. The portfolio's mix is held constant; taxes, fees and health insurance are not included.
                History since 2000 was a good period for many of these holdings, so the bad-case column is a sensible one to plan around.
                These are estimates, not financial advice.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
