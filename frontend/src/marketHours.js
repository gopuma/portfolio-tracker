/**
 * New York stock market hours (NYSE and Nasdaq share one calendar) seen from Seoul.
 *
 * Every session is built from New York wall-clock times (pre-market 04:00, regular
 * 09:30–16:00, after-hours to 20:00) and converted to an instant through the IANA zone,
 * so US daylight saving time is handled by the browser's time-zone data: the regular
 * session is 23:30–06:00 in Seoul in winter and 22:30–05:00 in summer. Korea has no DST.
 *
 * Holidays and 13:00 early closes follow the NYSE's published rules. Unscheduled closures
 * (a national day of mourning, a storm) can't be computed and are not included.
 */

export const NY = 'America/New_York';
export const SEOUL = 'Asia/Seoul';
const DAY_MS = 86_400_000;

// ---- time zones ---------------------------------------------------------------------

const partFormatters = new Map();
function partFormatter(tz) {
  if (!partFormatters.has(tz)) {
    partFormatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return partFormatters.get(tz);
}

/** Wall-clock parts of an instant in a zone: { y, m (1-based), d, h, mi, s }. */
export function zonedParts(ms, tz) {
  const p = {};
  for (const { type, value } of partFormatter(tz).formatToParts(ms)) p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/** The zone's offset from UTC at an instant, in ms (New York in winter: −5 h). */
export function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time occurs in a zone. Market times never fall in a DST gap. */
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

// ---- calendar dates (no time zone: plain Y/M/D arithmetic in UTC) ----------------------

/** Normalised date, so day 0 or day 32 roll into the neighbouring month. wd: 0 = Sunday. */
export function ymd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay() };
}
export const addDays = (p, n) => ymd(p.y, p.m, p.d + n);
export const dateKey = p => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

/** Day of month of the nth given weekday (n = −1: the last one). */
function nthWeekday(y, m, wd, n) {
  if (n > 0) return 1 + ((wd - ymd(y, m, 1).wd + 7) % 7) + (n - 1) * 7;
  const last = ymd(y, m + 1, 0);
  return last.d - ((last.wd - wd + 7) % 7);
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return ymd(y, Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1);
}

/** A fixed-date holiday on a weekend is observed on Friday (Saturday) or Monday (Sunday). */
function observed(y, m, d) {
  const p = ymd(y, m, d);
  return p.wd === 6 ? addDays(p, -1) : p.wd === 0 ? addDays(p, 1) : p;
}

const holidayCache = new Map();
/** NYSE full-day holidays of a year: Map 'YYYY-MM-DD' → English name. */
export function nyseHolidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const days = [];
  // New Year's Day on a Saturday is not moved back into the old year; on a Sunday it moves to Monday.
  const ny = ymd(y, 1, 1);
  if (ny.wd !== 6) days.push([ny.wd === 0 ? addDays(ny, 1) : ny, "New Year's Day"]);
  days.push([ymd(y, 1, nthWeekday(y, 1, 1, 3)), 'Martin Luther King Jr. Day']);
  days.push([ymd(y, 2, nthWeekday(y, 2, 1, 3)), "Washington's Birthday"]);
  days.push([addDays(easter(y), -2), 'Good Friday']);
  days.push([ymd(y, 5, nthWeekday(y, 5, 1, -1)), 'Memorial Day']);
  if (y >= 2022) days.push([observed(y, 6, 19), 'Juneteenth']);
  days.push([observed(y, 7, 4), 'Independence Day']);
  days.push([ymd(y, 9, nthWeekday(y, 9, 1, 1)), 'Labor Day']);
  days.push([ymd(y, 11, nthWeekday(y, 11, 4, 4)), 'Thanksgiving Day']);
  days.push([observed(y, 12, 25), 'Christmas Day']);
  const map = new Map(days.map(([p, name]) => [dateKey(p), name]));
  holidayCache.set(y, map);
  return map;
}

const earlyCache = new Map();
/** NYSE 13:00 early closes of a year: Map 'YYYY-MM-DD' → English reason. */
export function nyseEarlyCloses(y) {
  if (earlyCache.has(y)) return earlyCache.get(y);
  const days = [];
  // July 3 and December 24 close early only on Monday–Thursday; on a Friday the holiday
  // itself (falling on Saturday) is observed that day instead.
  const jul3 = ymd(y, 7, 3);
  if (jul3.wd >= 1 && jul3.wd <= 4) days.push([jul3, 'Day before Independence Day']);
  days.push([ymd(y, 11, nthWeekday(y, 11, 4, 4) + 1), 'Day after Thanksgiving']);
  const dec24 = ymd(y, 12, 24);
  if (dec24.wd >= 1 && dec24.wd <= 4) days.push([dec24, 'Christmas Eve']);
  const map = new Map(days.map(([p, why]) => [dateKey(p), why]));
  earlyCache.set(y, map);
  return map;
}

// ---- sessions -----------------------------------------------------------------------

/** New York calendar date of an instant. */
export function nyDate(ms) {
  const p = zonedParts(ms, NY);
  return ymd(p.y, p.m, p.d);
}

/**
 * One New York trading day. Closed days: { key, date, closed: 'weekend' | holiday name }.
 * Open days: [start, end] instants (ms) for pre, regular and post, plus the early-close
 * reason or null.
 */
export function nySession(date) {
  const key = dateKey(date);
  if (date.wd === 0 || date.wd === 6) return { key, date, closed: 'weekend' };
  const holiday = nyseHolidays(date.y).get(key);
  if (holiday) return { key, date, closed: holiday };
  const early = nyseEarlyCloses(date.y).get(key) || null;
  const at = (h, mi) => zonedToUtc(date.y, date.m, date.d, h, mi, NY);
  const close = early ? 13 : 16;
  return {
    key, date, closed: null, early,
    pre: [at(4, 0), at(9, 30)],
    regular: [at(9, 30), at(close, 0)],
    post: [at(close, 0), at(close + 4, 0)],
  };
}

/** The first open session whose regular hours haven't ended at `ms`, searching ahead. */
function sessionFrom(ms) {
  let date = nyDate(ms);
  for (let i = 0; i < 15; i++, date = addDays(date, 1)) {
    const s = nySession(date);
    if (!s.closed && ms < s.post[1]) return s;
  }
  return null;
}

/**
 * Where the market stands at `ms`:
 *   phase    'pre' | 'open' | 'post' | 'closed'
 *   session  the session `ms` falls in (pre/open/post), else the next one
 *   nextOpen the next regular open (null while open)
 *   closesAt the regular close (only while open)
 *   closedToday  the holiday name when New York's current date is a holiday, else null
 */
export function marketStatus(ms) {
  const today = nySession(nyDate(ms));
  const closedToday = today.closed && today.closed !== 'weekend' ? today.closed : null;
  const s = sessionFrom(ms);
  const within = ([a, b]) => ms >= a && ms < b;
  if (s && within(s.regular)) return { phase: 'open', session: s, closesAt: s.regular[1], nextOpen: null, closedToday };
  if (s && within(s.pre)) return { phase: 'pre', session: s, nextOpen: s.regular[0], closedToday };
  if (s && within(s.post)) {
    const next = sessionFrom(s.post[1]);
    return { phase: 'post', session: s, nextOpen: next?.regular[0] ?? null, nextSession: next, closedToday };
  }
  return { phase: 'closed', session: s, nextOpen: s?.regular[0] ?? null, closedToday };
}

/**
 * The New York sessions as they fall across one Seoul calendar day, for a 24-hour
 * timeline. Each band: { kind: 'pre' | 'regular' | 'post', from, to } as fractions of the
 * day, plus its session. Also the holidays New York observes during the window.
 */
export function seoulDayBands(ms) {
  const sp = zonedParts(ms, SEOUL);
  const start = zonedToUtc(sp.y, sp.m, sp.d, 0, 0, SEOUL);
  const next = ymd(sp.y, sp.m, sp.d + 1);
  const end = zonedToUtc(next.y, next.m, next.d, 0, 0, SEOUL);
  const span = end - start;
  const bands = [];
  const holidays = [];
  for (let date = addDays(nyDate(start), -1); dateKey(date) <= dateKey(nyDate(end)); date = addDays(date, 1)) {
    const s = nySession(date);
    if (s.closed) {
      if (s.closed !== 'weekend') {
        const noon = zonedToUtc(date.y, date.m, date.d, 12, 0, NY);
        if (noon - DAY_MS / 2 < end && noon + DAY_MS / 2 > start) holidays.push(s.closed);
      }
      continue;
    }
    for (const kind of ['pre', 'regular', 'post']) {
      const a = Math.max(s[kind][0], start), b = Math.min(s[kind][1], end);
      if (b > a) bands.push({ kind, from: (a - start) / span, to: (b - start) / span, session: s });
    }
  }
  return { start, end, now: (ms - start) / span, bands, holidays };
}

/**
 * The next US clock change after `ms` (Korea doesn't change its clocks, so every Seoul
 * time shifts by an hour). { date: the New York date it takes effect, dstStarts, session:
 * a representative session after the change } or null.
 */
export function nextClockChange(ms) {
  const base = nyDate(ms);
  const noonOffset = p => offsetMs(zonedToUtc(p.y, p.m, p.d, 12, 0, NY), NY);
  const now = noonOffset(base);
  for (let i = 1; i <= 370; i++) {
    const p = addDays(base, i);
    const o = noonOffset(p);
    if (o !== now) {
      // Sessions from the change on: the first weekday after it, ignoring holidays only for timing.
      let q = p;
      while (q.wd === 0 || q.wd === 6) q = addDays(q, 1);
      const at = (h, mi) => zonedToUtc(q.y, q.m, q.d, h, mi, NY);
      return { date: p, dstStarts: o > now, regular: [at(9, 30), at(16, 0)] };
    }
  }
  return null;
}
