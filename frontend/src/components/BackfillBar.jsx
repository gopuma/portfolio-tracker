import { useEffect, useState } from 'react';
import { api } from '../api.js';

const STATUS_POLL_MS = 5 * 60_000;

// 'Tue 06:30' in the viewer's timezone, or '–'.
function fmtWhen(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Price updates. Prices refresh on their own (see backend jobs/): every instrument after
 * each US close (Tue–Sat 06:30 KST), fetching back to its last stored price so a gap from
 * the backend being off fills itself, and crypto every hour. The top line shows when that
 * last ran, when it runs next, and anything still stale.
 *
 * The manual control below it triggers /api/refresh?days=N across all instruments, for
 * deeper history (e.g. 3-year return coverage) without dropping to the shell.
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
  const [status, setStatus] = useState(null);

  const loadStatus = () => api.refreshStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, STATUS_POLL_MS);
    return () => clearInterval(t);
  }, []);

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
      loadStatus();
    } catch (e) {
      setErr(e.message);
    } finally {
      setRunning(false);
    }
  };

  const daily = status?.daily;
  const stale = status?.stale || [];
  const dim = { fontSize: 12, color: 'var(--text-dim)' };

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Prices · automatic
        </div>
        {status ? (
          <>
            <span style={{ fontSize: 12, fontWeight: 600, color: stale.length ? 'var(--amber)' : 'var(--green)' }}>
              {stale.length ? `${stale.length} of ${status.instruments} behind` : `All ${status.instruments} up to date`}
            </span>
            <span style={dim}>
              Last update {fmtWhen(daily?.last_finished_at)}{daily?.last_reason === 'catch-up' ? ' (catch-up)' : ''}
              {' · '}next {fmtWhen(daily?.next_run)}
              {status.crypto?.last_finished_at && <> · crypto hourly, last {fmtWhen(status.crypto.last_finished_at)}</>}
            </span>
            {stale.length > 0 && (
              <span style={{ ...dim, flexBasis: '100%' }} title="Latest stored price is older than expected; the next automatic run retries these">
                Behind: {stale.slice(0, 8).map(s => `${s.symbol} (${s.latest || 'no prices'})`).join(', ')}{stale.length > 8 ? ` +${stale.length - 8} more` : ''}
              </span>
            )}
          </>
        ) : (
          <span style={dim}>Checking…</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
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
    </div>
  );
}
