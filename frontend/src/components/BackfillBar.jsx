import { useState } from 'react';
import { api } from '../api.js';

/**
 * Small control for triggering /api/refresh?days=N across all instruments.
 * Useful for filling in deeper history (e.g. 3-year return coverage) without
 * dropping to the shell.
 *
 * Note: refresh is synchronous on the backend — Yahoo calls are throttled
 * (~1.2s each) plus retry backoff, so a 1200-day backfill across many
 * tickers can take several minutes. The button stays disabled until the
 * request returns.
 */
export default function BackfillBar({ onDone }) {
  const [days, setDays] = useState(2);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const run = async () => {
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const r = await api.refreshAll(days);
      const ok = (r.results || []).filter(x => !x.prices_error).length;
      const fail = (r.results || []).length - ok;
      setResult({ ok, fail, days: r.days });
      if (onDone) onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Backfill prices
      </div>
      <input
        type="number"
        min={1}
        max={4000}
        value={days}
        onChange={e => setDays(Number(e.target.value))}
        disabled={running}
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
      <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>days back</span>
      <button className="btn" onClick={run} disabled={running || !days || days < 1}>
        {running ? 'Backfilling…' : 'Run'}
      </button>
      {result && (
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Done · {result.ok} ok{result.fail ? `, ${result.fail} failed` : ''} · {result.days}d
        </span>
      )}
      {err && <span style={{ fontSize: 12, color: 'var(--red)' }}>Error: {err}</span>}
      {running && (
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          Yahoo calls are throttled — this can take several minutes.
        </span>
      )}
    </div>
  );
}
