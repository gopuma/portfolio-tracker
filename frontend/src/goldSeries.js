/**
 * Daily series for the KRX vs international gold comparison. International gold (USD/oz)
 * is restated in KRW/g at each day's USD/KRW rate, so both lines share one unit and the
 * gap between them is the Korean premium on that day.
 */

export const GRAMS_PER_TROY_OZ = 31.1034768;

// [{trade_date, close_px}] → [{t: 'YYYY-MM-DD', v}], ascending, bad rows dropped.
export function rowsOf(prices) {
  return (prices || [])
    .map(p => ({ t: (p.trade_date || '').slice(0, 10), v: Number(p.close_px) }))
    .filter(r => r.t && Number.isFinite(r.v) && r.v > 0)
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

/**
 * International gold in KRW/g: USD/oz × KRW per USD ÷ grams per ounce. Each day uses the
 * latest rate on or before it (FX and gold have different holidays); days before the
 * first rate are dropped.
 */
export function intlKrwPerGram(intlRows, fxRows) {
  const out = [];
  let j = -1;
  for (const r of intlRows) {
    while (j + 1 < fxRows.length && fxRows[j + 1].t <= r.t) j++;
    if (j < 0) continue;
    out.push({ t: r.t, v: (r.v * fxRows[j].v) / GRAMS_PER_TROY_OZ });
  }
  return out;
}

/**
 * Both series by date, from `cut` on: {date, krx, intl, premium, above, below}. On days
 * with both prices, `premium` is KRX over international as a fraction, and `above` /
 * `below` are the [low, high] band between the two lines when KRX is above / below
 * (zero-width otherwise, so each band stays continuous for shading).
 */
export function mergeGold(krxRows, intlRows, cut = '') {
  const map = new Map();
  for (const r of krxRows) if (r.t >= cut) map.set(r.t, { date: r.t, krx: r.v });
  for (const r of intlRows) {
    if (r.t < cut) continue;
    const e = map.get(r.t) || { date: r.t };
    e.intl = r.v;
    map.set(r.t, e);
  }
  const out = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const e of out) {
    if (e.krx == null || e.intl == null) continue;
    e.premium = e.krx / e.intl - 1;
    e.above = [e.intl, Math.max(e.krx, e.intl)];
    e.below = [Math.min(e.krx, e.intl), e.intl];
  }
  return out;
}

/**
 * 1Y / 3Y / 5Y mean of a series, counted back from `today` (YYYY-MM-DD). Windows that run
 * past the available history just average whatever exists.
 */
export function averages(rows, today = new Date().toISOString().slice(0, 10)) {
  const avgOver = nDays => {
    const c = new Date(`${today}T00:00:00Z`);
    c.setUTCDate(c.getUTCDate() - nDays);
    const cut = c.toISOString().slice(0, 10);
    const sel = rows.filter(r => r.t >= cut);
    if (sel.length === 0) return null;
    return sel.reduce((a, r) => a + r.v, 0) / sel.length;
  };
  return { y1: avgOver(365), y3: avgOver(1095), y5: avgOver(1825) };
}

// Round steps for an axis: 1, 2, 2.5 or 5 × a power of ten. niceStep is the largest not
// above `x`; nextStep the one after `s`.
function niceStep(x) {
  const base = Math.pow(10, Math.floor(Math.log10(x)));
  return [5, 2.5, 2, 1].map(k => k * base).find(s => s <= x);
}
function nextStep(s) {
  const base = Math.pow(10, Math.floor(Math.log10(s) + 1e-9));
  const k = Math.round((s / base) * 10) / 10;
  return (k < 2 ? 2 : k < 2.5 ? 2.5 : k < 5 ? 5 : 10) * base;
}

/**
 * Tight y-axis for a chart: from just below the lowest value to just above the highest,
 * on round ticks, about `ticks` of them (at most one more). `clip` leaves that share of values at each end
 * outside the axis (so one spike doesn't flatten everything else); `include` values are
 * always kept in range. Returns {domain, ticks, clipped} (clipped: values left outside).
 */
export function axisRange(values, { ticks = 6, clip = 0, include = [] } = {}) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return { domain: ['auto', 'auto'], ticks: undefined, clipped: 0 };
  const at = q => v[Math.round(q * (v.length - 1))];
  let lo = Math.min(at(clip), ...include);
  let hi = Math.max(at(1 - clip), ...include);
  if (hi === lo) { const pad = Math.abs(lo) * 0.01 || 1; lo -= pad; hi += pad; }
  // The finest round step that needs at most one tick more than asked for (more and the
  // chart starts hiding labels).
  let step = niceStep((hi - lo) / (ticks - 1));
  while (Math.ceil(hi / step - 1e-9) - Math.floor(lo / step + 1e-9) + 1 > ticks + 1) step = nextStep(step);
  const from = Math.floor(lo / step + 1e-9) * step;
  const to = Math.ceil(hi / step - 1e-9) * step;
  const out = [];
  for (let x = from; x <= to + step / 2; x += step) out.push(Number(x.toFixed(10)));
  return { domain: [out[0], out[out.length - 1]], ticks: out, clipped: v.filter(x => x < out[0] || x > out[out.length - 1]).length };
}
