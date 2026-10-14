import { useEffect, useState } from 'react';
import { api } from './api.js';

const POLL_MS = 60_000; // one batched quote call a minute while the page is open

/**
 * Live intraday quotes for a set of symbols, fetched on mount and polled.
 *
 * Read-only by design: /prices/quotes is a single batched Yahoo call that never writes
 * to the database, so the stored daily close stays the source of truth and these values
 * exist only for as long as the page is open.
 *
 * Symbols Yahoo has no quote for (synthetic ones like KRX-GOLD-SPOT) are simply absent
 * from the returned map — callers fall back to their stored close.
 *
 * @param {string[]} symbols
 * @returns {{quotes: Object|null, err: string|null, loading: boolean}}
 */
export function useLiveQuotes(symbols, { pollMs = POLL_MS } = {}) {
  // Depend on the joined string, not the array — a fresh array literal on every render
  // would otherwise restart the interval each time.
  const key = [...new Set(symbols || [])].sort().join(',');
  const [quotes, setQuotes] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!key) { setQuotes(null); setErr(null); return; }
    let cancelled = false;
    setLoading(true);
    const load = () => api.liveQuotes(key.split(','))
      .then(d => { if (!cancelled) { setQuotes(d.quotes || {}); setErr(null); } })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    load();
    const t = setInterval(load, pollMs);
    return () => { cancelled = true; clearInterval(t); };
  }, [key, pollMs]);

  return { quotes, err, loading };
}
