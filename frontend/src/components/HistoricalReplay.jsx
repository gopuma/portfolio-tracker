import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
  ReferenceLine, ReferenceArea, Cell, LabelList,
} from 'recharts';
import { api } from '../api.js';
import {
  RED, DIM, ACCENT, BASELINE, BASELINE_OPACITY, DIMMED_OPACITY, tooltipStyle, inputStyle, dimLabel,
  fmtPct, fmtNum, fmtMoney, fmtCompact, cls, signColor, HoldingPctLabel, PortfolioTick, PortfolioChips,
} from './stressShared.jsx';

// Events tagged group 'crypto' (bitcoin's own crashes and rallies) get their own row.
const GROUPS = [
  { kind: 'crash', label: 'Crashes' },
  { kind: 'boom', label: 'Booms' },
  { kind: 'crypto', label: 'Crypto' },
];
const BASES = [
  { key: 'factor', label: "Today's sensitivities", hint: 'Every holding follows its proxy index, scaled by its beta to that proxy today — the factor-model approach risk systems use' },
  { key: 'actual', label: 'Actual prices where available', hint: "Holdings that were trading at the time use their own past prices; best for recent events" },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = ymd => {
  if (!ymd) return '–';
  const [y, m, d] = ymd.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};
const fmtMonth = ymd => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(2, 4)}`;

// % label at the outer end of a horizontal bar: left of a negative bar, right of a positive.
function EndLabel({ x, y, width, height, value }) {
  if (value == null) return null;
  const neg = value < 0;
  const end = neg ? Math.min(x, x + width) : Math.max(x, x + width);
  return (
    <text x={end + (neg ? -5 : 5)} y={y + height / 2} dy={4} textAnchor={neg ? 'end' : 'start'} fill={signColor(value)} fontSize={11} fontWeight={600}>
      {fmtPct(value)}
    </text>
  );
}

// Where a holding's path came from, in words.
function sourceText(h, ccy) {
  const s = h.source;
  if (s.kind === 'cash') return h.label.endsWith(ccy) ? 'Cash' : 'Exchange rate';
  if (s.kind === 'own') return 'Own prices';
  if (s.series === 'TBILL') return '3-month T-bills';
  const beta = s.beta != null ? ` × β ${fmtNum(s.beta)}` : '';
  return s.kind === 'fallback' ? `S&P 500${beta}` : `${s.name}${beta}`;
}

function PortfolioTip({ active, payload, ccy }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ ...tooltipStyle, padding: '8px 10px', borderRadius: 6 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{p.name}</div>
      <div>Now: {fmtMoney(p.current, ccy)}</div>
      <div className={cls(p.end_return)}>At the end: {fmtMoney(p.end_value, ccy)} ({fmtPct(p.end_return)})</div>
      <div className={cls(p.max_drawdown)}>Worst fall: {fmtPct(p.max_drawdown)}</div>
      <div style={{ color: DIM }}>{fmtDate(p.dd_peak)} → {fmtDate(p.dd_trough)}</div>
    </div>
  );
}

function PathTip({ active, payload, label, nameById }) {
  if (!active || !payload?.length) return null;
  const rows = [...payload].sort((a, b) => b.value - a.value);
  return (
    <div style={{ ...tooltipStyle, padding: '8px 10px', borderRadius: 6 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{fmtDate(label)}</div>
      {rows.map(r => (
        <div key={r.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span style={{ color: r.stroke === ACCENT ? ACCENT : DIM }}>{nameById.get(Number(r.dataKey))}</span>
          <span className={cls(r.value)}>{fmtPct(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function HoldingTip({ active, payload, ccy }) {
  if (!active || !payload?.length) return null;
  const h = payload[0].payload;
  return (
    <div style={{ ...tooltipStyle, padding: '8px 10px', borderRadius: 6 }}>
      <div style={{ fontWeight: 600 }}>{h.label}</div>
      {h.display_name && h.display_name !== h.label && <div style={{ color: DIM, marginBottom: 4 }}>{h.display_name}</div>}
      <div>Now: {fmtMoney(h.current, ccy)}</div>
      <div className={cls(h.end_return)}>At the end: {fmtMoney(h.end_value, ccy)} ({fmtPct(h.end_return)})</div>
      <div className={cls(h.worst_return)}>Lowest point: {fmtPct(h.worst_return)}</div>
      <div style={{ color: DIM }}>Replayed from: {sourceText(h, ccy)}</div>
    </div>
  );
}

/**
 * Historical replay: today's holdings run through what actually happened in a past crash or
 * boom, day by day, with each portfolio's result at the end and its worst fall along the
 * way (maximum drawdown). The engine is services/historicalReplay.js on the backend.
 */
export default function HistoricalReplay() {
  const [events, setEvents] = useState([]);
  const [eventKey, setEventKey] = useState('gfc');
  const [basis, setBasis] = useState('factor');
  const [ccy, setCcy] = useState('USD');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const navigate = useNavigate();

  useEffect(() => {
    api.stressEvents().then(d => setEvents(d.events || [])).catch(e => setErr(e.message));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.stressReplay(eventKey, ccy, basis)
      .then(d => { if (!cancelled) { setData(d); setErr(null); } })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [eventKey, ccy, basis]);

  const results = data?.portfolios || [];
  const shown = useMemo(() => results.filter(p => !hidden.has(p.id)), [results, hidden]);
  const nameById = useMemo(() => new Map(results.map(p => [p.id, p.name])), [results]);
  const selected = shown.find(p => p.id === selectedId) || shown[0] || null;

  // Percent axis for the portfolio chart, covering both the end results and the worst falls.
  const pctAxis = useMemo(() => {
    const vals = shown.flatMap(p => [p.end_return, p.max_drawdown]);
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const pad = Math.max((hi - lo) * 0.14, 0.06);
    const min = lo < 0 ? lo - pad : 0, max = hi > 0 ? hi + pad : 0;
    const step = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10].find(st => (max - min) / st <= 8) || 20;
    const ticks = [];
    for (let t = Math.ceil(min / step - 1e-9); t <= Math.floor(max / step + 1e-9); t++) ticks.push(t * step);
    return { domain: [min, max], ticks };
  }, [shown]);

  // One row per day for the path chart, keyed by portfolio id.
  const pathRows = useMemo(() => {
    if (!data) return [];
    return data.dates.map((date, i) => {
      const row = { date };
      for (const p of shown) row[p.id] = p.path[i];
      return row;
    });
  }, [data, shown]);

  const totals = useMemo(() => {
    const current = shown.reduce((a, p) => a + p.current, 0);
    const end = shown.reduce((a, p) => a + p.end_value, 0);
    return { current, end, pct: current > 0 ? end / current - 1 : 0 };
  }, [shown]);

  const ev = data?.event;
  const fallbackCount = selected ? selected.holdings.filter(h => h.source.kind === 'fallback').length : 0;
  const spanYears = ev ? (Date.parse(ev.last_date) - Date.parse(ev.first_date)) / (365.25 * 86400000) : 0;

  return (
    <div>
      <div className="panel">
        {GROUPS.map(g => (
          <div key={g.kind} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ ...dimLabel, width: 56 }}>{g.label}</span>
            {events.filter(e => (e.group || e.kind) === g.kind).map(e => (
              <button key={e.key} className={`btn ${eventKey === e.key ? '' : 'ghost'}`} title={e.note} onClick={() => setEventKey(e.key)}>
                {e.label}{e.group && <span className={eventKey === e.key ? '' : e.kind === 'crash' ? 'down' : 'up'} style={{ opacity: 0.9 }}> {e.kind === 'crash' ? '↓' : '↑'}</span>}
              </button>
            ))}
          </div>
        ))}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <span style={dimLabel}>Replay with</span>
          {BASES.map(b => (
            <button key={b.key} className={`btn ${basis === b.key ? '' : 'ghost'}`} title={b.hint} onClick={() => setBasis(b.key)}>{b.label}</button>
          ))}
          <span style={{ ...dimLabel, marginLeft: 12 }}>Show in</span>
          {['USD', 'KRW'].map(c => (
            <button key={c} className={`btn ${ccy === c ? '' : 'ghost'}`} onClick={() => setCcy(c)}>{c}</button>
          ))}
        </div>

        {ev && (
          <p style={{ margin: '14px 0 0', fontSize: 13, lineHeight: 1.6 }}>
            <span style={{ fontWeight: 600 }}>{ev.label}</span>: {fmtDate(ev.first_date)} → {fmtDate(ev.last_date)}
            <span style={{ color: 'var(--text-dim)' }}> · {data.dates.length} trading days · {ev.note}</span>
            <br />
            {data.indexes.filter(i => i.change != null).map((i, k) => (
              <span key={i.series}>{k > 0 && ', '}{i.name} <span className={cls(i.change)} style={{ fontWeight: 600 }}>{fmtPct(i.change)}</span></span>
            ))}
            {data.won_vs_usd != null && <>; the won <span className={cls(data.won_vs_usd)} style={{ fontWeight: 600 }}>{fmtPct(data.won_vs_usd)}</span> against the dollar</>}
          </p>
        )}
      </div>

      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}

      {loading && !data ? (
        <div className="panel"><div className="loading">Replaying…</div></div>
      ) : !data || results.length === 0 ? (
        !err && <div className="panel"><div className="loading">No portfolios with priced holdings.</div></div>
      ) : (
        <>
          {/* All portfolios: end result and worst fall */}
          <div className="panel" style={{ opacity: loading ? 0.6 : 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
              <h2 style={{ margin: 0 }}>Portfolios through the {ev.kind === 'boom' ? 'boom' : 'crash'}</h2>
              <div style={{ fontSize: 13 }}>
                {shown.length === results.length ? 'All portfolios' : `${shown.length} of ${results.length} portfolios`}: {fmtMoney(totals.current, ccy)} → <span style={{ fontWeight: 600 }}>{fmtMoney(totals.end, ccy)}</span>{' '}
                <span className={cls(totals.pct)}>({fmtMoney(totals.end - totals.current, ccy)}, {fmtPct(totals.pct)})</span>
              </div>
            </div>
            <PortfolioChips portfolios={results} hidden={hidden} setHidden={setHidden} />

            {shown.length === 0 ? (
              <div className="loading">No portfolios selected. Pick one or more above.</div>
            ) : (
              <>
                <div style={{ width: '100%', height: Math.max(180, shown.length * 58 + 60), marginTop: 12 }}>
                  <ResponsiveContainer>
                    <BarChart data={shown} layout="vertical" margin={{ top: 4, right: 40, left: 10, bottom: 4 }} barGap={2}
                      onClick={e => { const id = e?.activePayload?.[0]?.payload?.id; if (id != null) setSelectedId(id); }}>
                      <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" stroke={DIM} fontSize={11} domain={pctAxis.domain} ticks={pctAxis.ticks}
                        tickFormatter={v => `${(Math.round(v * 100) || 0).toLocaleString()}%`} />
                      <YAxis type="category" dataKey="id" stroke={DIM} width={120} interval={0}
                        tick={<PortfolioTick nameById={nameById} onOpen={id => navigate(`/portfolios/${id}`)} />} />
                      <ReferenceLine x={0} stroke={DIM} />
                      <Tooltip content={<PortfolioTip ccy={ccy} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="end_return" name="At the end" fill={ACCENT} radius={2} maxBarSize={18} style={{ cursor: 'pointer' }}>
                        {shown.map(p => <Cell key={p.id} fill={ACCENT} fillOpacity={selected?.id === p.id ? 1 : DIMMED_OPACITY + 0.2} />)}
                        <LabelList dataKey="end_return" content={EndLabel} />
                      </Bar>
                      <Bar dataKey="max_drawdown" name="Worst fall along the way" fill={BASELINE} fillOpacity={0.55} radius={2} maxBarSize={18} style={{ cursor: 'pointer' }}>
                        <LabelList dataKey="max_drawdown" content={EndLabel} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <table style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th>Portfolio</th>
                      <th className="num">Now</th>
                      <th className="num">At the end</th>
                      <th className="num">Change</th>
                      <th className="num">%</th>
                      <th className="num" title="Largest fall from a high point to a later low point during the event">Worst fall</th>
                      <th className="num">Lowest on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(p => (
                      <tr key={p.id} onClick={() => setSelectedId(p.id)} style={{ cursor: 'pointer', background: selected?.id === p.id ? 'var(--panel-2)' : undefined }}>
                        <td><Link to={`/portfolios/${p.id}`} onClick={e => e.stopPropagation()}>{p.name}</Link></td>
                        <td className="num">{fmtMoney(p.current, ccy)}</td>
                        <td className="num">{fmtMoney(p.end_value, ccy)}</td>
                        <td className={`num ${cls(p.end_value - p.current)}`}>{fmtMoney(p.end_value - p.current, ccy)}</td>
                        <td className={`num ${cls(p.end_return)}`}>{fmtPct(p.end_return)}</td>
                        <td className={`num ${cls(p.max_drawdown)}`}>{fmtPct(p.max_drawdown)}</td>
                        <td className="num" style={{ color: 'var(--text-dim)' }}>{p.max_drawdown < 0 ? fmtDate(p.dd_trough) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>

          {/* The path through the event */}
          {selected && (
            <div className="panel" style={{ opacity: loading ? 0.6 : 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
                <h2 style={{ margin: 0 }}>Day by day</h2>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  <span style={{ color: ACCENT }}>{selected.name}</span>, others in grey · shaded: its worst fall ({fmtPct(selected.max_drawdown)})
                </div>
              </div>
              <div style={{ width: '100%', height: 300, marginTop: 12 }}>
                <ResponsiveContainer>
                  <LineChart data={pathRows} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
                    <XAxis dataKey="date" stroke={DIM} fontSize={11} minTickGap={48} tickFormatter={spanYears > 0.4 ? fmtMonth : (d => fmtDate(d).replace(/ \d{4}$/, ''))} />
                    <YAxis stroke={DIM} fontSize={11} width={52} tickFormatter={v => `${Math.round(v * 100)}%`} domain={['auto', 'auto']} />
                    <ReferenceLine y={0} stroke={DIM} />
                    {selected.max_drawdown < 0 && (
                      <ReferenceArea x1={selected.dd_peak} x2={selected.dd_trough} fill={RED} fillOpacity={0.08} stroke="none" />
                    )}
                    <Tooltip content={<PathTip nameById={nameById} />} />
                    {shown.filter(p => p.id !== selected.id).map(p => (
                      <Line key={p.id} type="monotone" dataKey={String(p.id)} stroke={BASELINE} strokeOpacity={0.45} strokeWidth={1} dot={false} isAnimationActive={false} />
                    ))}
                    <Line type="monotone" dataKey={String(selected.id)} stroke={ACCENT} strokeWidth={2.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

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
                    <Tooltip content={<HoldingTip ccy={ccy} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="current" name="Now" fill={BASELINE} fillOpacity={BASELINE_OPACITY} radius={2} />
                    <Bar dataKey="end_value" name="At the end" fill={ACCENT} radius={2}>
                      <LabelList dataKey="end_return" content={HoldingPctLabel} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <table style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Holding</th>
                    <th title="Whose prices this holding followed through the event, and its beta to them today">Replayed from</th>
                    <th className="num">Now</th>
                    <th className="num">At the end</th>
                    <th className="num">%</th>
                    <th className="num" title="Its lowest point during the event, from the start">Lowest point</th>
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
                      </td>
                      <td style={{ color: h.source.kind === 'fallback' ? 'var(--amber)' : 'var(--text-dim)' }}
                        title={h.source.kind === 'fallback' ? 'No proxy has prices this far back, so this follows the S&P 500 by its beta to it' : undefined}>
                        {sourceText(h, ccy)}{h.source.kind === 'fallback' && '*'}
                      </td>
                      <td className="num">{fmtMoney(h.current, ccy)}</td>
                      <td className="num">{fmtMoney(h.end_value, ccy)}</td>
                      <td className={`num ${cls(h.end_return)}`}>{fmtPct(h.end_return)}</td>
                      <td className={`num ${cls(h.worst_return)}`}>{fmtPct(h.worst_return)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {fallbackCount > 0 && (
                <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--amber)' }}>
                  * {fallbackCount} holding{fallbackCount > 1 ? 's' : ''} with no proxy reaching back to {ev.first_date.slice(0, 4)} (daily KOSPI starts Dec 1996, gold futures Aug 2000,
                  bitcoin Sep 2014, the Russell 2000 Sep 1987); {fallbackCount > 1 ? 'these follow' : 'it follows'} the S&P 500 by {fallbackCount > 1 ? 'their' : 'its'} beta to it instead.
                </p>
              )}
            </div>
          )}

          <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: '0 4px' }}>
            <p style={{ margin: '0 0 6px' }}>
              <strong style={{ color: 'var(--text)' }}>How this is replayed.</strong>{' '}
              Today's holdings, at today's values, are carried through the event day by day using what markets actually did, and nothing is rebalanced along the way.
              {basis === 'factor'
                ? ' Each holding follows a proxy with a long history — its sector or market index, or for funds the index they track — scaled by its beta to that proxy over the last three years. That is the factor-model approach (past factor moves × today\'s sensitivities): a company\'s own early history, such as Amazon\'s eightfold first year after listing in 1997, doesn\'t stand in for how it behaves today.'
                : ' Holdings that were trading for the whole event use their own past prices, dividends included; the rest follow a proxy, scaled by their beta to it. Own prices are exact, but for a long-ago event they show the company as it was then.'}
            </p>
            <p style={{ margin: 0 }}>
              Prices are converted to {ccy} at each day's actual exchange rate, so won holdings and cash carry the won's moves through the event. T-bill funds earn the T-bill rate of the time.
              The worst fall is the largest drop from a high to a later low inside the event window. Past events show how this portfolio would have fared then, not a forecast of the next one.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
