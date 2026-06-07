import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const fieldStyle = {
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '6px 8px',
  fontSize: 13,
};

// Map Yahoo quote types to our asset_class ENUM.
function assetClassFor(type) {
  if (type === 'ETF' || type === 'MUTUALFUND') return 'ETF';
  return 'STOCK';
}

/**
 * "+ Add" control for a market section. Search a stock by name or symbol and pick
 * a match to add it to the watchlist (no volume — these are tracked instruments, not holdings).
 */
export default function AddTicker({ market, onAdded }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);
  const [highlight, setHighlight] = useState(0); // keyboard-highlighted result index
  const activeRef = useRef(null);

  // Debounced name/symbol search.
  useEffect(() => {
    if (!open || query.trim().length < 2) { setResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      api.searchSymbols(query.trim(), market)
        .then(r => { if (!cancelled) { setResults(r.results || []); setShowResults(true); setHighlight(0); } })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, open]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [highlight]);

  // Arrow keys navigate the dropdown; Enter picks; Escape closes the list.
  const onSearchKeyDown = (e) => {
    if (!showResults || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = results[highlight]; if (r) choose(r); }
    else if (e.key === 'Escape') { e.preventDefault(); setShowResults(false); }
  };

  const close = () => { setOpen(false); setQuery(''); setResults([]); setShowResults(false); setErr(null); setOk(null); };

  const choose = async (r) => {
    setBusy(true); setErr(null); setOk(null); setShowResults(false);
    try {
      await api.addInstrument({ symbol: r.symbol, market, asset_class: assetClassFor(r.type), display_name: r.name });
      setOk(`Added ${r.symbol}`);
      setQuery(''); setResults([]);
      onAdded?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="btn ghost" onClick={() => { setErr(null); setOk(null); setOpen(true); }} title={`Add a ${market} ticker`}>
        + Add ticker
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', width: 280 }}>
        <input
          autoFocus
          value={query}
          onChange={e => { setQuery(e.target.value); setOk(null); }}
          onFocus={() => results.length && setShowResults(true)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search by name or symbol…"
          disabled={busy}
          style={{ ...fieldStyle, width: '100%' }}
        />
        {showResults && results.length > 0 && (
          <div style={{ position: 'absolute', zIndex: 10, left: 0, right: 0, marginTop: 4, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, maxHeight: 280, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
            {results.map((r, i) => (
              <button
                key={r.symbol}
                type="button"
                ref={i === highlight ? activeRef : null}
                onClick={() => choose(r)}
                onMouseEnter={() => setHighlight(i)}
                disabled={busy}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', background: i === highlight ? 'var(--panel)' : 'transparent', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--text)', padding: '8px 10px', cursor: 'pointer' }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-dim)' }}>{r.symbol} · {r.exchange}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="btn ghost" type="button" onClick={close} disabled={busy}>Done</button>
      {busy && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Adding & backfilling…</span>}
      {searching && !busy && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Searching…</span>}
      {ok && <span style={{ fontSize: 12, color: 'var(--green)' }}>{ok}</span>}
      {err && <span style={{ fontSize: 12, color: 'var(--red)' }}>Error: {err}</span>}
    </div>
  );
}
