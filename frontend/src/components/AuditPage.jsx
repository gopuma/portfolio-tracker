import { useEffect, useState } from 'react';
import { api } from '../api.js';

const STATUS_COLOR = { ok: 'var(--green)', warn: 'var(--amber)', fail: 'var(--red)' };

function StatusPill({ status }) {
  const map = { ok: 'green', warn: 'amber', fail: 'red' };
  return <span className={`pill ${map[status] || ''}`}>{status.toUpperCase()}</span>;
}

// The fixed check order the backend emits (live appended when enabled).
const CHECK_COLS = ['price', 'coverage', 'integrity', 'volatility', 'returns', 'live price'];

export default function AuditPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [live, setLive] = useState(false);

  const run = (withLive = live) => {
    setLoading(true); setErr(null);
    api.audit(withLive).then(setData).catch(e => setErr(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => { run(false); /* eslint-disable-next-line */ }, []);

  const cols = CHECK_COLS.filter(c => c !== 'live price' || (data?.live));

  return (
    <>
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>Data Audit</h2>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
              Independently recomputes and cross-checks each instrument's values.
              {data?.generated_at ? ` Last run: ${new Date(data.generated_at).toLocaleString()}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={live} onChange={e => { setLive(e.target.checked); run(e.target.checked); }} style={{ width: 16, height: 16 }} />
              Live price check (Yahoo)
            </label>
            <button className="btn" onClick={() => run()} disabled={loading}>{loading ? 'Auditing…' : 'Re-run'}</button>
          </div>
        </div>

        {data && (
          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <Chip label="Pass" n={data.summary.ok} color="var(--green)" />
            <Chip label="Warnings" n={data.summary.warn} color="var(--amber)" />
            <Chip label="Failures" n={data.summary.fail} color="var(--red)" />
          </div>
        )}
        {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}
      </div>

      <div className="panel">
        {loading ? (
          <div className="loading">Running audit…</div>
        ) : !data ? null : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Market</th>
                  <th>Overall</th>
                  {cols.map(c => <th key={c} style={{ textTransform: 'capitalize' }}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.items.map(it => {
                  const byCheck = Object.fromEntries(it.checks.map(c => [c.check, c]));
                  return (
                    <tr key={it.symbol}>
                      <td style={{ fontWeight: 600 }}>{it.symbol}</td>
                      <td><span className="pill">{it.market}</span></td>
                      <td><StatusPill status={it.status} /></td>
                      {cols.map(col => {
                        const c = byCheck[col];
                        if (!c) return <td key={col} style={{ color: 'var(--text-dim)' }}>–</td>;
                        return (
                          <td key={col} style={{ color: STATUS_COLOR[c.status], whiteSpace: 'nowrap' }} title={`${c.status.toUpperCase()}: ${c.detail}`}>
                            {c.detail}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 12, marginBottom: 0, lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>price</strong>: present, positive, fresh ·
          <strong style={{ color: 'var(--text)' }}> coverage</strong>: obs in last 1y ·
          <strong style={{ color: 'var(--text)' }}> integrity</strong>: implausible 1-day jumps ·
          <strong style={{ color: 'var(--text)' }}> volatility</strong>: production calc vs an independent recompute ·
          <strong style={{ color: 'var(--text)' }}> returns</strong>: 30d/1y recomputed ·
          <strong style={{ color: 'var(--text)' }}> live price</strong>: stored close vs live Yahoo quote.
          Includes reference instruments (FX, indexes, gold) — high VIX volatility / index returns are expected, not errors.
        </p>
      </div>
    </>
  );
}

function Chip({ label, n, color }) {
  return (
    <div style={{ border: `1px solid ${color}`, color, borderRadius: 6, padding: '6px 12px', fontSize: 13, fontWeight: 600 }}>
      {label}: {n}
    </div>
  );
}
