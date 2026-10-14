import { useEffect, useState } from 'react';

/**
 * D-Day countdown to the retirement date.
 *
 * Counts whole calendar days in the viewer's local timezone, following the Korean
 * convention: D-541 with days to go, D-Day on the day itself, D+N afterwards.
 *
 * Everything is computed from local Y/M/D parts rather than timestamp arithmetic.
 * Subtracting two Date values and dividing by 86,400,000 is off by an hour across a
 * DST boundary, which silently shifts the count by a day for part of the year.
 */

// Retirement date, local time. Month is 1-based here (the Date constructor's is not).
export const RETIREMENT = { year: 2028, month: 2, day: 5 };

const MS_PER_DAY = 86_400_000;

/** Whole days from today to the target, positive when the target is still ahead. */
function daysUntil(target, now = new Date()) {
  // Normalise both ends to local midnight so partial days can't tip the result.
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const b = new Date(target.year, target.month - 1, target.day);
  // UTC-based difference of two local midnights: exact whole days, DST included.
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
    - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / MS_PER_DAY);
}

/** ms until the next local midnight, so the card can re-tick without a reload. */
function msToMidnight(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Calendar years/months/days remaining — friendlier than a raw day count at this range. */
function breakdown(target, now = new Date()) {
  let y = target.year - now.getFullYear();
  let m = target.month - 1 - now.getMonth();
  let d = target.day - now.getDate();
  if (d < 0) {
    m -= 1;
    // Days in the month preceding the target date — day 0 of a month is the last of the previous.
    d += new Date(target.year, target.month - 1, 0).getDate();
  }
  if (m < 0) { y -= 1; m += 12; }
  return { y, m, d };
}

const fmtDate = ({ year, month, day }) =>
  new Date(year, month - 1, day).toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

export default function RetirementCountdown({ target = RETIREMENT, label = 'Retirement' }) {
  // Re-render exactly at local midnight so the number is never stale on a page left open.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => tick(n => n + 1), msToMidnight() + 1000);
    return () => clearTimeout(t);
  });

  const days = daysUntil(target);
  const { y, m, d } = breakdown(target);
  const past = days < 0;
  const today = days === 0;

  // D-Day notation: D-n before, D-Day on the day, D+n after.
  const dday = today ? 'D-Day' : past ? `D+${Math.abs(days)}` : `D-${days}`;

  const parts = [
    y > 0 && `${y} year${y === 1 ? '' : 's'}`,
    m > 0 && `${m} month${m === 1 ? '' : 's'}`,
    d > 0 && `${d} day${d === 1 ? '' : 's'}`,
  ].filter(Boolean);

  return (
    <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
      <div>
        <div className="metric-label">{label}</div>
        <div
          className="metric"
          style={{ fontSize: 40, letterSpacing: '-0.02em', color: today ? 'var(--green)' : 'var(--accent)', lineHeight: 1.1 }}
        >
          {dday}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 4 }}>
          {today
            ? 'Today is the day.'
            : past
              ? `Retired since ${fmtDate(target)}.`
              : `${parts.join(', ')} to go · ${fmtDate(target)}`}
        </div>
      </div>

      {!past && !today && (
        <div style={{ textAlign: 'right' }}>
          <div className="metric-label">Days remaining</div>
          <div className="metric" style={{ fontSize: 26, fontVariantNumeric: 'tabular-nums' }}>
            {days.toLocaleString()}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
            ≈ {Math.round(days / 7).toLocaleString()} weeks · {countWeekdays(target).toLocaleString()} working days
          </div>
        </div>
      )}
    </div>
  );
}

/** Mon–Fri between tomorrow and the target inclusive — public holidays not deducted. */
function countWeekdays(target, now = new Date()) {
  const end = new Date(target.year, target.month - 1, target.day);
  const cur = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let n = 0;
  while (cur <= end) {
    const wd = cur.getDay();
    if (wd !== 0 && wd !== 6) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}
