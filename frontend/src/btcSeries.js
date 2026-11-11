/**
 * Daily series for the bitcoin panel: the global price (BTC-USD) restated in won at each
 * day's USD/KRW rate, so it shares one unit with Upbit's KRW-BTC and the gap between the
 * two lines is the Korean ("kimchi") premium on that day. Merging, averages and axes reuse
 * the gold panel's helpers in goldSeries.js.
 */

/**
 * USD rows → KRW rows: each day's value × the latest rate on or before it. Bitcoin trades
 * every day and FX doesn't, so weekends and holidays carry Friday's rate forward. Days
 * before the first rate are dropped.
 */
export function usdToKrw(usdRows, fxRows) {
  const out = [];
  let j = -1;
  for (const r of usdRows) {
    while (j + 1 < fxRows.length && fxRows[j + 1].t <= r.t) j++;
    if (j < 0) continue;
    out.push({ t: r.t, v: r.v * fxRows[j].v });
  }
  return out;
}
