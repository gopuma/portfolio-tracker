import { useEffect, useMemo, useState } from 'react';
import { t, locale } from '../i18n.jsx';
import { NY, SEOUL, zonedToUtc, marketStatus, seoulDayBands, nextClockChange } from '../marketHours.js';

/**
 * New York market hours on a Seoul clock, kept to two lines: the market's status with a
 * countdown and both clocks, then a thin 24-hour bar of today in Seoul with the sessions
 * drawn on it (hover a band for its times). All times come from marketHours.js; nothing
 * is fetched.
 */

const formatters = new Map();
function fmt(lang, opts) {
  const key = lang + JSON.stringify(opts);
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(lang, opts));
  return formatters.get(key);
}
const hm = (ms, tz = SEOUL) => fmt('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
const weekday = ms => fmt(locale(), { timeZone: SEOUL, weekday: 'short' }).format(ms);
const zoneAbbr = (ms, tz) => fmt('en-US', { timeZone: tz, timeZoneName: 'short' })
  .formatToParts(ms).find(p => p.type === 'timeZoneName')?.value || '';
const longDate = ms => fmt(locale(), { timeZone: NY, year: 'numeric', month: 'short', day: 'numeric' }).format(ms);

/** 2d 4h, 3h 12m or 25m, rounded up to the minute. */
function duration(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return t('{d}d {h}h', { d, h });
  if (h > 0) return t('{h}h {m}m', { h, m });
  return t('{m}m', { m });
}

const PHASE = {
  open: { label: 'Market open', color: 'var(--green)' },
  pre: { label: 'Pre-market', color: 'var(--amber)' },
  post: { label: 'After-hours', color: 'var(--amber)' },
  closed: { label: 'Market closed', color: 'var(--text-dim)' },
};
const KIND = { pre: 'Pre-market', regular: 'Regular session', post: 'After-hours' };
const TICKS = [0, 6, 12, 18, 24];

/** Current time, refreshed every 15 seconds (the card shows minutes). */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export default function MarketHoursCard() {
  const now = useNow();
  const minute = Math.floor(now / 60_000);
  const { status, day, change } = useMemo(() => {
    const ms = minute * 60_000;
    return { status: marketStatus(ms), day: seoulDayBands(ms), change: nextClockChange(ms) };
  }, [minute]);

  const phase = PHASE[status.phase];
  const s = status.session;

  let countdown = null;
  if (status.phase === 'open') {
    countdown = t('Closes in {dur} · {time} Seoul', { dur: duration(status.closesAt - now), time: hm(status.closesAt) });
  } else if (status.nextOpen) {
    countdown = t('Opens in {dur} · {when} Seoul', {
      dur: duration(status.nextOpen - now), when: `${weekday(status.nextOpen)} ${hm(status.nextOpen)}`,
    });
  }
  // Only on the rare days it applies: a New York holiday or a 13:00 early close.
  const note = status.closedToday
    ? t('New York is closed today: {name}', { name: t(status.closedToday) })
    : s?.early && status.phase !== 'closed'
      ? t('Early close at 13:00 New York time ({why})', { why: t(s.early) })
      : null;
  const clockTitle = change && t('Next US clock change: {date} ({what})', {
    date: longDate(zonedToUtc(change.date.y, change.date.m, change.date.d, 12, 0, NY)),
    what: t(change.dstStarts ? 'daylight saving time starts' : 'daylight saving time ends'),
  });

  return (
    <div className="panel mh">
      <div className="mh-row">
        <span className="metric-label">{t('US Market')}</span>
        <span className="mh-status" style={{ color: phase.color }}>
          <span className="mh-dot" style={{ background: phase.color }} />
          {t(phase.label)}
        </span>
        {countdown && <span className="mh-dim">{countdown}</span>}
        {note && <span style={{ color: 'var(--amber)' }}>{note}</span>}
        <span className="mh-clocks">
          {t('Seoul')} <b>{hm(now)}</b>
          <span title={clockTitle || undefined}>{t('New York')} <b>{hm(now, NY)}</b> {zoneAbbr(now, NY)}</span>
        </span>
      </div>

      <div className="mh-timeline">
        <div className="mh-track">
          {day.bands.map((b, i) => (
            <div
              key={i}
              className={`mh-band ${b.kind}`}
              style={{ left: `${b.from * 100}%`, width: `${(b.to - b.from) * 100}%` }}
              title={`${t(KIND[b.kind])} ${hm(b.session[b.kind][0])}–${hm(b.session[b.kind][1])} ${t('Seoul')}`}
            />
          ))}
        </div>
        <div className="mh-now" style={{ left: `${Math.min(Math.max(day.now, 0), 1) * 100}%` }} />
      </div>
      <div className="mh-ticks">
        {TICKS.map(h => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}</span>)}
      </div>
    </div>
  );
}
