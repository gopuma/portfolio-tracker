import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend,
} from 'recharts';
import { api } from '../api.js';
import { historyStats, combineHistory, MIN_PATHS } from '../projection/simulate.js';
import { DIM, ACCENT, BASELINE, tooltipStyle, inputStyle, dimLabel, chipStyle, fmtMoney, fmtCompact } from './stressShared.jsx';
import { t, isKo } from '../i18n.jsx';

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
  other: 550_000_000,       // assets outside the tracked portfolios
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
      <span style={dimLabel} title={hint ? t(hint) : undefined}>{t(label)}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function Metric({ label, value, sub, title }) {
  return (
    <div className="panel" style={{ marginBottom: 0 }} title={title ? t(title) : undefined}>
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
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('Year {n}', { n: d.year })}</div>
      {row(t('Good (1 in 20)'), d.p95)}
      {row(t('75th percentile'), d.p75)}
      {row(t('Median'), d.p50, true)}
      {row(t('25th percentile'), d.p25)}
      {row(t('Bad (1 in 20)'), d.p5)}
      {d.out > 0 && <div style={{ color: 'var(--amber)', marginTop: 4 }}>{t('Run out by now')}: {fmtPctPlain(d.out)}</div>}
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
  const perMonth = v => t('{v} / month', { v: fmtCompact(v / 12, ccy) });
  const netDraw = spending != null ? spending - income : 0;

  return (
    <div>
      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}
      {!data ? (
        !err && <div className="panel"><div className="loading">{t('Loading your portfolios and their history since 2000…')}</div></div>
      ) : (
        <>
          <div className="panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
              <h2 style={{ margin: 0 }}>{t('Portfolio projection')}</h2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={dimLabel}>{t('Show in')}</span>
                {['KRW', 'USD'].map(c => (
                  <button key={c} className={`btn ${ccy === c ? '' : 'ghost'}`} onClick={() => setCcy(c)}>{c}</button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 14 }}>
              <span style={{ ...dimLabel, marginRight: 4 }}>{t('Portfolios')}</span>
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
                {other > 0 && <span style={dimLabel}>{t('{pct} of the balance', { pct: fmtPctPlain(otherShare) })}</span>}
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
            <h2>{t('Assumptions')}</h2>
            <div className="grid-3" style={{ alignItems: 'start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Field label={cashShare > 0 ? 'Rate of return on investments (average per year)' : 'Rate of return (average per year)'}
                  hint={cashShare > 0 ? t('Expected annual return before inflation, in {ccy}, for everything except {ccy} cash', { ccy }) : t('Expected annual return before inflation, in {ccy}', { ccy })}>
                  <PctInput value={mean} onChange={v => { setMeanFollows(false); setMean(v); }} />
                </Field>
                <Field label="Volatility (per year)" hint="Standard deviation of annual returns of the investments">
                  <PctInput value={vol} onChange={setVol} min={0} />
                </Field>
                {hist && (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                    {t('History of {what}, {from}–{to}:', { what: cashShare > 0 ? t('these investments') : t("today's mix"), from: data.months[0]?.slice(0, 4), to: data.history_to?.slice(0, 4) })}{' '}
                    {t('{mean} average ({compound} compound), {vol} volatility.', { mean: fmtPctPlain(hist.mean), compound: fmtPctPlain(hist.compound), vol: fmtPctPlain(hist.vol) })}
                    {' '}{t("Default: cash's rate + {k} × volatility, a cautious long-run reward for risk, since that period favoured these holdings.", { k: DEFAULTS.sharpe })}{' '}
                    <span style={{ display: 'inline-flex', gap: 6, marginTop: 4 }}>
                      <button className="btn ghost" style={{ ...chipStyle, padding: '1px 8px' }} onClick={useDefaults}>{t('Default ({v}%)', { v: defaultMean })}</button>
                      <button className="btn ghost" style={{ ...chipStyle, padding: '1px 8px' }}
                        onClick={() => { setMeanFollows(false); setMean((hist.mean * 100).toFixed(1)); setVol((hist.vol * 100).toFixed(1)); }}>{t('History ({v}%)', { v: (hist.mean * 100).toFixed(1) })}</button>
                    </span>
                  </div>
                )}
                {cashShare > 0 && (
                  <Field label={t('{ccy} cash earns (above inflation)', { ccy })} hint="Savings-account rate over inflation; cash keeps pace with each path's inflation plus this">
                    <PctInput value={cashSpread} onChange={setCashSpread} min={-5} max={10} />
                    <span style={dimLabel}>{t('{pct} of the balance', { pct: fmtPctPlain(cashShare) })} · {t('{pct} a year', { pct: fmtPctPlain(cashRate) })}</span>
                  </Field>
                )}
                {(cashShare > 0 || other > 0) && mean !== '' && (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                    {t('Investments {a} · cash {b} · other {c}.', { a: fmtPctPlain(investedShare), b: fmtPctPlain(cashShare), c: fmtPctPlain(otherShare) })}
                    {' '}{t('Whole balance: about')} <span style={{ color: 'var(--text)', fontWeight: 600 }}>{fmtPctPlain(blended)}</span> {t('a year on average')}
                    {' '}({t('{pct} above inflation', { pct: fmtPctPlain((1 + blended) / (1 + num(inflation) / 100) - 1) })}).
                  </div>
                )}
                <Field label="Return model">
                  {MODELS.map(m => (
                    <button key={m.key} className={`btn ${model === m.key ? '' : 'ghost'}`} style={chipStyle} title={t(m.hint)} onClick={() => setModel(m.key)}>{t(m.label)}</button>
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
                  <span style={dimLabel}>{t('years')}{income > 0 ? ` · ${perMonth(income)}` : ''}</span>
                </Field>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Field label="Spending rule">
                  {STRATEGIES.map(s => (
                    <button key={s.key} className={`btn ${strategy === s.key ? '' : 'ghost'}`} style={chipStyle} title={t(s.hint)} onClick={() => setStrategy(s.key)}>{t(s.label)}</button>
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
                    {netDraw > 0
                      ? t("Once income starts, the portfolio pays {v} a year ({pct} of today's balance).", { v: fmtCompact(netDraw, ccy), pct: fmtPctPlain(start > 0 ? netDraw / start : 0, 2) })
                      : t('Once income starts, the portfolio pays nothing; income covers spending.')}
                  </div>
                )}
              </div>
            </div>
          </div>

          {simErr && <div className="error" style={{ marginBottom: 16 }}>{simErr}</div>}
          {chosen.length === 0 && other <= 0 ? (
            <div className="panel"><div className="loading">{t('Pick a portfolio or enter other assets to project.')}</div></div>
          ) : !result ? (
            <div className="panel"><div className="loading">{t('Simulating {n} paths…', { n: paths.toLocaleString() })}</div></div>
          ) : (
            <div style={{ opacity: running ? 0.6 : 1, transition: 'opacity .15s' }}>
              <div className="grid-5" style={{ marginBottom: 16 }}>
                {result.strategy === 'fixed' ? (
                  <Metric label={t('Lasts {n} years', { n: result.years })} value={fmtPctPlain(result.success)}
                    sub={result.firstRunOut ? t('{n} of {total} paths run out, typically in year {y}', { n: result.firstRunOut.count.toLocaleString(), total: result.paths.toLocaleString(), y: Math.ceil(result.firstRunOut.p50) }) : t('No path ran out')}
                    title="Share of paths that never run out of money" />
                ) : (
                  <Metric label={t('Spending in year {n}', { n: result.years })} value={fmtCompact(result.spending[result.years - 1].p50, ccy)}
                    sub={t("Bad case {v} a year, today's money", { v: fmtCompact(result.spending[result.years - 1].p5, ccy) })}
                    title="Median yearly spending in the final year under the percent rule, in today's money" />
                )}
                <Metric label={t("Keeps today's value")} value={fmtPctPlain(result.keepStart)}
                  sub={t("Ends above {v} in today's money", { v: fmtCompact(start, ccy) })} />
                <Metric label={t('Median, year {n}', { n: result.years })} value={fmtCompact(endReal.p50, ccy)} sub={t("Today's money")} />
                <Metric label={t('Bad case, year {n}', { n: result.years })} value={fmtCompact(endReal.p5, ccy)} sub={t("1 in 20 ends lower · today's money")} />
                <Metric label={t('Most you could spend')} value={fmtCompact(result.safeSpending.lasts90, ccy)}
                  sub={t('a year ({pm}) and still last {n} years in 9 of 10 paths', { pm: perMonth(result.safeSpending.lasts90), n: result.years })}
                  title="Highest fixed inflation-adjusted spending at which 90% of paths never run out, with the same income" />
              </div>

              <div className="panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
                  <h2 style={{ margin: 0 }}>{t('Balance over time')}</h2>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ ...dimLabel, fontSize: 11 }}>{t('{n} paths', { n: result.paths.toLocaleString() })} · {(result.ms / 1000).toFixed(1)}s</span>
                    <button className="btn ghost" style={chipStyle} title={t('Run again with new random numbers')} onClick={() => setSeed(s => s + 1)}>{t('Re-run')}</button>
                    {[['real', "Today's money"], ['nominal', 'Future money']].map(([k, label]) => (
                      <button key={k} className={`btn ${view === k ? '' : 'ghost'}`} style={chipStyle} onClick={() => setView(k)}>{t(label)}</button>
                    ))}
                  </div>
                </div>
                <div style={{ width: '100%', height: 360, marginTop: 12 }}>
                  <ResponsiveContainer>
                    <ComposedChart data={chartRows} margin={{ top: 8, right: 16, left: 10, bottom: 4 }}>
                      <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
                      <XAxis dataKey="year" stroke={DIM} fontSize={11} tickFormatter={y => t('{n}y', { n: y })} />
                      <YAxis stroke={DIM} fontSize={11} width={70} tickFormatter={v => fmtCompact(v, ccy)} />
                      <Tooltip content={<FanTip ccy={ccy} />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <ReferenceLine y={start} stroke={BASELINE} strokeDasharray="4 4" label={{ value: t('Start'), fill: DIM, fontSize: 11, position: 'insideTopLeft' }} />
                      {income > 0 && num(incomeStart) > 0 && num(incomeStart) < result.years && (
                        <ReferenceLine x={Math.round(num(incomeStart))} stroke={BASELINE} strokeDasharray="2 4"
                          label={{ value: t('Income starts'), fill: DIM, fontSize: 11, position: 'insideTopRight' }} />
                      )}
                      <Area dataKey="outer" name={t('5–95% of paths')} stroke="none" fill={ACCENT} fillOpacity={0.14} isAnimationActive={false} />
                      <Area dataKey="inner" name={t('25–75%')} stroke="none" fill={ACCENT} fillOpacity={0.28} isAnimationActive={false} />
                      <Line dataKey="p50" name={t('Median')} stroke={ACCENT} strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line dataKey="p5" name={t('Bad case (1 in 20)')} stroke={BASELINE} strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <table style={{ marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th>{t('Year')}</th>
                      <th className="num" title={t('5th percentile: 1 path in 20 ends lower')}>{t('Bad (1 in 20)')}</th>
                      <th className="num">{t('25th')}</th>
                      <th className="num">{t('Median')}</th>
                      <th className="num">{t('75th')}</th>
                      <th className="num" title={t('95th percentile: 1 path in 20 ends higher')}>{t('Good (1 in 20)')}</th>
                      {result.strategy === 'percent'
                        ? <th className="num" title={t("Median spending that year, in today's money")}>{t('Spending (median)')}</th>
                        : <th className="num">{t('Run out by then')}</th>}
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
                  {t("Keep {start} in today's money with 90% confidence: spend up to {k90} a year ({pm}); with 75%: {k75} a year.", { start: fmtCompact(start, ccy), k90: fmtCompact(result.safeSpending.keeps90, ccy), pm: perMonth(result.safeSpending.keeps90), k75: fmtCompact(result.safeSpending.keeps75, ccy) })}
                  {' '}{t('Lasting {n} years with 95% confidence: up to {v} a year.', { n: result.years, v: fmtCompact(result.safeSpending.lasts95, ccy) })}
                  {view === 'nominal' && end && <> {t("Future money at year {n} includes inflation; the median path's prices are about {x}× today's.", { n: result.years, x: (endReal.p50 > 0 ? end.p50 / endReal.p50 : 0).toFixed(2) })}</>}
                </p>
              </div>

              <div className="panel" style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                {isKo() ? (
                  <>
                    <strong style={{ color: 'var(--text)' }}>작동 방식.</strong> {result.paths.toLocaleString()}개의 경로 각각이 월 단위로 진행됩니다:
                    지출을 인출하고(그 경로의 누적 인플레이션만큼 인상), 소득이 시작되면 더한 뒤, 잔액이 무작위 수익을 얻습니다.
                    {model === 'historical'
                      ? <> 수익률은 현재 보유 종목이 {data.months[0]} 이후 거두었을 성과(<Link to="/stress">과거 재현</Link>처럼 각 종목이 현재 베타로 대용 지수를 따라감)에서 12개월 단위 블록을 무작위로 뽑아, 위의 수익률과 변동성에 맞게 조정한 것입니다.</>
                      : <> 수익률은 위의 수익률과 변동성을 갖는 서로 독립인 로그정규 분포입니다.</>}
                    {cashShare > 0 && <> {ccy} 현금(잔액의 {fmtPctPlain(cashShare)})은 각 경로의 인플레이션에 위의 가산 금리를 더해 얻습니다.</>}
                    {other > 0 && <> 기타 자산({fmtPctPlain(otherShare)})은 매년 {fmtPctPlain(num(otherRate) / 100)}의 일정한 수익을 얻습니다.</>}
                    {' '}세 부분은 매월 리밸런싱합니다.
                    {' '}인플레이션은 위의 비율을 중심으로 매년 무작위로 정해집니다. 포트폴리오 구성은 일정하게 유지하며 세금, 수수료, 건강보험료는 포함하지 않습니다.
                    2000년 이후는 이 종목들 중 다수에 좋은 시기였으므로 나쁜 경우 열을 기준으로 계획하는 것이 합리적입니다.
                    이는 추정치이며 투자 조언이 아닙니다.
                  </>
                ) : (
                <>
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
                </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
