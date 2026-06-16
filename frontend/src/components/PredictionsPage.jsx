import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api.js';

function fmtPct(n, d = 1) {
  if (n == null || isNaN(n)) return '–';
  return `${(Number(n) * 100).toFixed(d)}%`;
}
function fmtNum(n, d = 2) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtSigned(n, d = 3) {
  if (n == null || isNaN(n)) return '–';
  const v = Number(n);
  return `${v > 0 ? '+' : ''}${v.toFixed(d)}`;
}
const cls = n => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');

// Clickable, sortable header (same pattern as the portfolio tables).
function SortTh({ label, col, num, sortKey, sortDir, onSort, title }) {
  const active = sortKey === col;
  return (
    <th
      className={num ? 'num' : undefined}
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      title={title || 'Click to sort'}
    >
      {label}<span style={{ opacity: active ? 1 : 0.25, marginLeft: 4 }}>{active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>
  );
}

const HORIZONS = [{ label: '5-Day', days: 5 }, { label: '30-Day', days: 30 }];

// Stable colors per model for the per-symbol chart.
const MODEL_COLORS = {
  'naive-rw-v1': '#9aa0a6',
  'drift-v1': '#4a9eff',
  'arima-v1': '#a855f7',
  'ets-v1': '#f59e0b',
  'ridge-v1': '#34d399',
  'montecarlo-v1': '#f472b6',
  'heuristic-v1': '#22d3ee',
  'gbm-v1': '#ef4444',
  'gbm-lgbm-v1': '#84cc16',
};

export default function PredictionsPage() {
  const [horizon, setHorizon] = useState(5);
  const [symbol, setSymbol] = useState('');     // '' = all stocks (aggregate)
  const [symbols, setSymbols] = useState([]);
  const [board, setBoard] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState('directional_accuracy');
  const [sortDir, setSortDir] = useState('desc');

  // Watchlist stocks for the scope selector (same filter the analytics page uses).
  useEffect(() => {
    api.instruments()
      .then(rows => setSymbols((rows || [])
        .filter(r => r.watchlist && r.market !== 'FX' && r.market !== 'INDEX')
        .map(r => ({ symbol: r.symbol, name: r.display_name || r.symbol }))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.leaderboard(horizon, symbol)
      .then(d => { if (!cancelled) setBoard(d); })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [horizon, symbol]);

  const onSort = (key) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'model_version' || key === 'family' ? 'asc' : 'desc'); }
  };

  const sorted = useMemo(() => {
    const rows = board?.models || [];
    const dir = sortDir === 'asc' ? 1 : -1;
    const blank = v => v == null || v === '' || (typeof v === 'number' && isNaN(v));
    return [...rows].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (blank(av) && blank(bv)) return 0;
      if (blank(av)) return 1;
      if (blank(bv)) return -1;
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return (Number(av) - Number(bv)) * dir;
    });
  }, [board, sortKey, sortDir]);

  return (
    <>
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 420px', minWidth: 0 }}>
            <h2 style={{ margin: 0 }}>Prediction Competition</h2>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
              {symbol
                ? <>Each model's accuracy on <strong style={{ color: 'var(--text)' }}>{symbol}</strong> at the selected horizon, </>
                : <>Each method forecasts every watchlist stock at the selected horizon; metrics aggregated across all stocks, </>}
              over a rolling {board?.window_days ?? 180}-trading-day, walk-forward backtest (no look-ahead).
              Ranked by directional accuracy; tie-break: RMSE skill vs the naive baseline.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto', flexShrink: 0 }}>
            <select
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              title="Scope the leaderboard to one stock, or all stocks"
              style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13 }}
            >
              <option value="">All stocks</option>
              {symbols.map(s => <option key={s.symbol} value={s.symbol}>{s.name} ({s.symbol})</option>)}
            </select>
            {HORIZONS.map(h => (
              <button key={h.days} className={`btn ${horizon === h.days ? '' : 'ghost'}`} onClick={() => setHorizon(h.days)}>
                {h.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        {loading ? (
          <div className="loading">Loading leaderboard…</div>
        ) : err ? (
          <div className="error">Failed to load: {err}</div>
        ) : !board || board.count === 0 ? (
          <div className="loading">No scored predictions yet — run <code>npm run backtest</code> to populate.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th className="num" style={{ width: 36 }}>#</th>
                  <SortTh label="Model" col="model_version" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="Family" col="family" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortTh label="Dir. Accuracy" col="directional_accuracy" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="% of forecasts that got the up/down direction right" />
                  <SortTh label="RMSE Skill" col="rmse_skill_vs_naive" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="1 − RMSE/RMSE_naive. >0 beats the random-walk baseline" />
                  <SortTh label="MAE (ret)" col="mae_return" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="Mean absolute error of predicted return" />
                  <SortTh label="Strat. Sharpe" col="strategy_sharpe" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="Sharpe of acting on the predicted direction" />
                  <SortTh label="Samples" col="n_samples" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="# matured predictions scored" />
                  <SortTh label="Coverage" col="coverage" num sortKey={sortKey} sortDir={sortDir} onSort={onSort} title="Predictions made vs the most-covering model" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((m, i) => {
                  // Grey rows that don't beat the naive baseline on RMSE skill.
                  const weak = !m.beats_naive;
                  return (
                    <tr key={m.model_version} style={{ opacity: weak ? 0.5 : 1 }}>
                      <td className="num" style={{ color: 'var(--text-dim)' }}>{i + 1}</td>
                      <td>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: MODEL_COLORS[m.model_version] || 'var(--text-dim)', marginRight: 8 }} />
                        {m.display_name}
                        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{m.model_version}</div>
                      </td>
                      <td><span className="pill">{m.family}</span></td>
                      <td className="num" style={{ fontWeight: 600 }}>{fmtPct(m.directional_accuracy)}</td>
                      <td className={`num ${cls(m.rmse_skill_vs_naive)}`}>{fmtSigned(m.rmse_skill_vs_naive)}</td>
                      <td className="num">{fmtPct(m.mae_return, 2)}</td>
                      <td className={`num ${cls(m.strategy_sharpe)}`}>{fmtNum(m.strategy_sharpe)}</td>
                      <td className="num">{m.n_samples}</td>
                      <td className="num">{fmtPct(m.coverage, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 12, marginBottom: 0, lineHeight: 1.6 }}>
              Greyed rows don't beat the <strong style={{ color: 'var(--text)' }}>naive random walk</strong> on RMSE skill.
              Beating random-walk on short-horizon direction is genuinely hard — that's the point of the baseline.
            </p>
          </div>
        )}
      </div>

      <PerSymbol horizon={horizon} symbols={symbols} pageSymbol={symbol} />
    </>
  );
}

// Per-symbol overlay: each model's predicted price vs the realized close.
// Driven by the shared stock list; follows the page scope selector but can also be
// pointed at a different stock independently (e.g. when the board shows "All stocks").
function PerSymbol({ horizon, symbols, pageSymbol }) {
  const [sel, setSel] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => { if (symbols.length && !sel) setSel(symbols[0].symbol); }, [symbols, sel]);
  useEffect(() => { if (pageSymbol) setSel(pageSymbol); }, [pageSymbol]);

  useEffect(() => {
    if (!sel) return;
    let cancelled = false;
    setErr(null);
    api.modelPredictions(sel, horizon)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [sel, horizon]);

  // Build chart rows keyed by maturity_date: actual close + each model's predicted price.
  const { chartData, models } = useMemo(() => {
    const hist = data?.history || [];
    const byDate = new Map();
    const modelSet = new Set();
    for (const h of hist) {
      const date = (h.maturity_date || '').slice(0, 10);
      if (!date) continue;
      modelSet.add(h.model_version);
      const row = byDate.get(date) || { date };
      row.actual = Number(h.realized_price);
      row[h.model_version] = Number(h.predicted_price);
      byDate.set(date, row);
    }
    return {
      chartData: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
      models: [...modelSet].sort(),
    };
  }, [data]);

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Predicted vs Actual — {horizon}-day</h3>
        <select
          value={sel}
          onChange={e => setSel(e.target.value)}
          style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13 }}
        >
          {symbols.map(s => <option key={s.symbol} value={s.symbol}>{s.name} ({s.symbol})</option>)}
        </select>
      </div>

      {err ? (
        <div className="error" style={{ marginTop: 12 }}>{err}</div>
      ) : chartData.length === 0 ? (
        <div className="loading" style={{ marginTop: 12 }}>No scored history yet for {sel}.</div>
      ) : (
        <div style={{ width: '100%', height: 340, marginTop: 12 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke="#2d3441" strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke="#9aa0a6" fontSize={11} minTickGap={40} />
              <YAxis stroke="#9aa0a6" fontSize={11} domain={['auto', 'auto']} tickFormatter={v => fmtNum(v, 0)} width={56} />
              <Tooltip contentStyle={{ background: '#1a1f29', border: '1px solid #2d3441' }} formatter={v => fmtNum(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="actual" name="Actual" stroke="#ffffff" strokeWidth={2.5} dot={false} connectNulls />
              {models.map(mv => (
                <Line key={mv} type="monotone" dataKey={mv} name={mv} stroke={MODEL_COLORS[mv] || '#888'} strokeWidth={1.5} dot={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 12, marginBottom: 0 }}>
        Each colored line is a model's {horizon}-day-ahead forecast plotted at its maturity date; the white line is the realized close.
      </p>
    </div>
  );
}
