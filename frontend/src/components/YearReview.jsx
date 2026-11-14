import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Cell, LabelList } from 'recharts';
import { api } from '../api.js';
import { t, locale } from '../i18n.jsx';

/**
 * Year-end investment review of one portfolio, laid out like the year-end review doc: a
 * title and byline, a summary, then (opened) how to read the numbers, where the money came
 * from, the year's profit in each currency, what drove it, an analysis, data checks and the
 * method. Every sentence is composed from the numbers, so it works for any portfolio and any
 * year from its first trade on.
 *
 * The current year comes in as `initial` (the page fetches it for its YTD Profit cards);
 * other years are fetched on demand from GET /portfolios/:id/ytd-profit?year=YYYY
 * (backend services/periodProfit.js yearReview).
 */

// ---- formatting -----------------------------------------------------------------------

const SYM = { KRW: '₩', USD: '$', JPY: '¥' };
const fmt = (n, ccy) => (n == null || isNaN(n) ? '–'
  : `${n < 0 ? '−' : ''}${SYM[ccy] || ''}${Math.abs(n).toLocaleString(locale(), { maximumFractionDigits: 0 })}${SYM[ccy] ? '' : ` ${ccy}`}`);
const signed = (n, ccy) => (n > 0 ? `+${fmt(n, ccy)}` : fmt(n, ccy));
// ₩53.9M / $19.5K, locale-aware; signed() adds the sign.
const shortAbs = (n, ccy) => `${SYM[ccy] || ''}${new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: Math.abs(n) >= 1000 ? 1 : 0 }).format(Math.abs(n))}${SYM[ccy] ? '' : ` ${ccy}`}`;
const short = (n, ccy) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${shortAbs(n, ccy)}`;
// One more digit (₩1.52B, +₩236.38M) where the bars are close in size.
const shortAbs2 = (n, ccy) => `${SYM[ccy] || ''}${new Intl.NumberFormat(locale(), { notation: 'compact', ...(Math.abs(n) >= 1000 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 }) }).format(Math.abs(n))}${SYM[ccy] ? '' : ` ${ccy}`}`;
const short2 = (n, ccy) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${shortAbs2(n, ccy)}`;
const fmtPx = (n, ccy) => `${SYM[ccy] || ''}${Number(n).toLocaleString(locale(), ccy === 'KRW' ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = n => (n == null || isNaN(n) ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n * 100).toFixed(1)}%`);
const share = n => `${Math.round(n * 100)}%`;
const rate = n => (n == null ? '–' : `₩${n.toLocaleString(locale(), { maximumFractionDigits: 2 })}`);
const cls = n => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');
const dateLabel = d => new Date(`${d}T00:00:00`).toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' });
const listOf = items => items.join(', ');

// ---- the panel ------------------------------------------------------------------------

/**
 * `page`: shown on its own page (PortfolioReview), always fully open. `year` / `onYear`
 * let that page keep the chosen year in its address; without them the panel keeps its own.
 */
export default function YearReview({ portfolioId, portfolioName, base, initial, ytd, page = false, year: yearProp, onYear }) {
  const [yearState, setYearState] = useState(initial?.year ?? null);
  const year = yearProp ?? yearState ?? initial?.year ?? null;
  const setYear = y => (onYear ? onYear(y) : setYearState(y));
  const [other, setOther] = useState(null); // a non-current year's review, once fetched
  const [loading, setLoading] = useState(false);
  const [openState, setOpen] = useState(false);
  const open = page || openState;
  const [view, setView] = useState(null);
  const [history, setHistory] = useState(null); // every year's assets and profit, for the chart

  useEffect(() => {
    let cancelled = false;
    api.portfolioYearHistory(portfolioId)
      .then(d => { if (!cancelled) setHistory(d); })
      .catch(() => { if (!cancelled) setHistory(null); });
    return () => { cancelled = true; };
  }, [portfolioId]);

  useEffect(() => {
    if (year == null || year === initial?.year) { setOther(null); return undefined; }
    let cancelled = false;
    setLoading(true);
    api.portfolioYtdProfit(portfolioId, year)
      .then(d => { if (!cancelled) setOther(d); })
      .catch(() => { if (!cancelled) setOther(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [portfolioId, year, initial]);

  if (!initial?.currencies) return null;
  const review = year === initial.year ? initial : other;
  const ccys = review?.currencies ? Object.keys(review.currencies) : [];
  // Sentences and bars default to won when it's there: the currency the money is spent in.
  const shown = view && ccys.includes(view) ? view : ccys.includes('KRW') ? 'KRW' : ccys[0];
  const ready = !loading && review?.currencies;
  // The year's money sources in currency c, with salary held to the year before's level.
  const fund = (c, r) => funding(r, salaryPriors(history, c).get(review?.year) ?? null);

  return (
    <article className={`panel doc-review${page ? ' dr-page' : ''}`}>
      <div className="dr-controls">
        <select className="dr-year" value={year ?? ''} onChange={e => setYear(Number(e.target.value))} aria-label={t('Year')}>
          {(initial.years || [initial.year]).map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        {ccys.length > 1 && ccys.map(c => (
          <button key={c} className={`btn ${c === shown ? '' : 'ghost'} dr-chip`} onClick={() => setView(c)}>{c}</button>
        ))}
        {!page && (
          <button className="btn ghost dr-chip dr-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {open ? t('Hide the full review') : t('Read the full review')} {open ? '▴' : '▾'}
          </button>
        )}
      </div>

      <h1>{t('{year} Year-End Investment Review', { year: year ?? '' })}</h1>
      {ready && (
        <p className="dr-byline">
          {review.current ? t('As of {date}', { date: dateLabel(review.currencies[shown].end) }) : t('Jan 1 – Dec 31, {year}', { year: review.year })}
          {portfolioName ? ` · ${portfolioName}` : ''}
        </p>
      )}

      {loading ? <p className="dr-dim">{t('Loading…')}</p> : !review?.currencies ? (
        <p className="dr-dim">{t('No trades recorded for this year.')}</p>
      ) : (
        <>
          <Summary review={review} ccys={ccys} ccy={shown} base={base} fund={fund} />
          <YearByYear history={history} ccy={shown} year={review.year} onYear={setYear} />
          {open && (
            <>
              <HowToRead />
              <MoneySources review={review} ccys={ccys} ccy={shown} fund={fund} />
              <ProfitTable review={review} ccys={ccys} ytd={review.current ? ytd : null} />
              <Drivers review={review} ccy={shown} />
              <Analysis review={review} ccy={shown} base={base} ccys={ccys} fund={fund} />
              <Checks checks={review.checks} />
              <Method review={review} />
            </>
          )}
        </>
      )}
    </article>
  );
}

// ---- shared reading of the numbers ---------------------------------------------------------

const periodOf = review => (review.current ? t('{year} to date', { year: review.year }) : t('Year {year}', { year: review.year }));
const result = (r, ccy) => `${signed(r.profit, ccy)} (${pct(r.return)})`;

/**
 * Where the year's purchases were paid from, from the records alone, in this order: cash
 * drawn down from recorded accounts (withdrawals − deposits), dividends received, holdings
 * entered as the records began (owned before, not bought), shares delivered to a stock-plan
 * account (stock pay), and the rest — money the app never saw, taken to be cash from salary.
 * Salary saved doesn't jump from one year to the next, so when that rest is more than
 * SALARY_JUMP × the year before's (`prior`), salary is held at the year before's level and the
 * excess counted as other cash savings. The note continues:
 * (it may include other savings). Cash drawn but not spent shows as such.
 */
const SALARY_JUMP = 1.5;
function funding(r, prior = null) {
  const net = r.bought - r.sold;
  const cash = r.cash.withdrawals - r.cash.deposits;
  const fromCash = Math.max(0, Math.min(cash, net));
  const fromDiv = Math.max(0, Math.min(r.dividends, net - fromCash));
  const outside = Math.max(0, net - fromCash - fromDiv);
  const opening = Math.min(r.opening || 0, outside);
  const stockPay = Math.min(r.stock_pay || 0, outside - opening);
  const rest = outside - opening - stockPay;
  const capped = prior > 0 && rest > prior * SALARY_JUMP;
  const salary = capped ? prior : rest;
  return { net, fromCash, fromDiv, outside, opening, stockPay, salary, savings: rest - salary, capped, prior, unspent: Math.max(0, cash - fromCash) };
}

/** Each year's prior for funding(): the year before's cash from salary, after its own cap. */
function salaryPriors(history, ccy) {
  const priors = new Map();
  let prev = null;
  for (const y of history?.years || []) {
    if (!y[ccy]) continue;
    priors.set(y.year, prev);
    prev = funding({ ...y[ccy], cash: y[ccy].cash_flows }, prev).salary;
  }
  return priors;
}

/**
 * The year's point in one sentence: what the investments earned in their own markets (every
 * exchange rate held at the start of the year), what the exchange rate added or took, and
 * the total in the currency shown — plus the other currency's total when it has the other sign.
 */
function leadSentence(review, ccys, ccy, base) {
  const period = periodOf(review);
  const r = review.currencies[ccy];
  const f = r.fixed_fx;
  const vars = {
    period, inv: `${signed(f.profit, ccy)} (${pct(f.return)})`, p: signed(f.price, ccy), d: signed(f.dividends, ccy),
    fx: shortAbs(r.fx_effect, ccy), total: result(r, ccy),
  };
  let text = t(r.fx_effect >= 0
    ? '{period}: the investments earned {inv} in their own markets: {p} from prices and {d} from dividends. The exchange rate added {fx}, for a total of {total}.'
    : '{period}: the investments earned {inv} in their own markets: {p} from prices and {d} from dividends. The exchange rate cost {fx}, for a total of {total}.', vars);
  const other = ccys.find(c => c !== ccy);
  if (other && Math.sign(review.currencies[other].profit) !== Math.sign(r.profit)) {
    text += ` ${t('Measured in {ccy}, the same year is {total}.', { ccy: other, total: result(review.currencies[other], other) })}`;
  }
  return text;
}

// ---- sections ---------------------------------------------------------------------------

function Summary({ review, ccys, ccy, base, fund }) {
  const r = review.currencies[ccy];
  const rows = r.by_symbol || [];
  const gains = rows.filter(x => x.investment > 0).slice(0, 3).map(x => x.symbol);
  const losses = rows.filter(x => x.investment < 0).reverse().slice(0, 3).map(x => x.symbol);
  const f = fund(ccy, r);
  const items = [];
  if (f.net > 0) {
    const parts = [
      [f.salary, 'cash from estimated salary {v}'], [f.savings, 'other cash savings {v}'], [f.stockPay, 'stock pay {v}'], [f.fromCash, 'recorded cash {v}'],
      [f.fromDiv, 'dividends {v}'], [f.opening, 'holdings owned before the records {v}'],
    ].filter(([v]) => v > 0.5).map(([v, label]) => t(label, { v: shortAbs(v, ccy) }));
    items.push([t('Money added'), t('{net} of purchases, net of sales: {parts}.', { net: shortAbs(f.net, ccy), parts: listOf(parts) })]);
  }
  if (gains.length) items.push([t('What helped'), r.dividends > 0
    ? t('{list}, plus {d} of dividends.', { list: listOf(gains), d: shortAbs(r.dividends, ccy) })
    : `${listOf(gains)}.`]);
  if (losses.length) items.push([t('What hurt'), `${listOf(losses)}.`]);
  const avg = (review.checks || []).filter(c => c.status === 'average').length;
  if (avg) items.push([t('Records'), t('{n} trades were entered at an average price, not the price that day; the profit counts them at that day’s close.', { n: avg })]);
  return (
    <section>
      <h2>{t('Summary')}</h2>
      <p>{leadSentence(review, ccys, ccy, base)}</p>
      {items.length > 0 && <ul>{items.map(([b, text], i) => <li key={i}><b>{b}:</b> {text}</li>)}</ul>}
    </section>
  );
}

function HowToRead() {
  const rows = [
    [t('Question it answers'), t('How good is my current mix?'), t('How much did my money really make?')],
    [t('Holdings counted'), t('Only the shares owned today'), t('Everything held this year, including sales')],
    [t('Start date'), t('As if owned since Jan 1'), t('Each purchase from its own date and price')],
    [t('Exchange-rate moves'), t('Ignored (both ends at today’s rate)'), t('Included')],
    [t('Dividends'), t('Ignored'), t('Included, after withholding tax')],
    [t('Percentage'), t('Price change of today’s holdings'), t('Profit ÷ (Dec 31 value + purchases)')],
  ];
  return (
    <section>
      <h2>{t('How to read the numbers')}</h2>
      <p>{t('The app shows two year-to-date figures. They answer different questions, and neither tracks where the money came from.')}</p>
      <table className="dr-table">
        <thead><tr><th /><th>YTD</th><th>{t('YTD Profit')}</th></tr></thead>
        <tbody>{rows.map(([a, b, c]) => <tr key={a}><td>{a}</td><td>{b}</td><td>{c}</td></tr>)}</tbody>
      </table>
      <p>{t('Money added during the year is not profit on either card. Cash balances are left out of both.')}</p>
      <p>{t('YTD Profit differs by currency. When the won strengthens, dollar holdings lose value in won and won holdings gain value in dollars. The same year can be a loss in won and a gain in dollars.')}</p>
    </section>
  );
}

function MoneySources({ review, ccys, ccy, fund }) {
  const fs = Object.fromEntries(ccys.map(c => [c, fund(c, review.currencies[c])]));
  const f = fs[ccy];
  if (!(f.net > 0)) return null;
  const row = (label, key, how, strong) => (
    <tr className={strong ? 'dr-strong' : undefined}>
      <td>{label}</td>
      {ccys.map(c => <td key={c} className="num">{fmt(fs[c][key], c)}</td>)}
      <td className="dr-how">{how}</td>
    </tr>
  );
  return (
    <section>
      <h2>{t('Where the money came from')}</h2>
      <p>
        {t('You bought {net} of investments in {year}, net of sales. Stock pay was {pay} ({payPct}) and cash from estimated salary {sal} ({salPct}).', {
          net: fmt(f.net, ccy), year: review.year, pay: fmt(f.stockPay, ccy), payPct: share(f.stockPay / f.net), sal: fmt(f.salary, ccy), salPct: share(f.salary / f.net),
        })}
        {f.capped && ` ${t('Money from outside the records came to {rest}, far above the year before’s salary level of {prior}, so salary is kept at that level and the other {sav} is counted as other cash savings.', {
          rest: fmt(f.salary + f.savings, ccy), prior: fmt(f.prior, ccy), sav: fmt(f.savings, ccy),
        })}`}
      </p>
      <table className="dr-table">
        <thead><tr><th>{t('Source')}</th>{ccys.map(c => <th key={c} className="num">{c}</th>)}<th>{t('How it was identified')}</th></tr></thead>
        <tbody>
          {row(t('Recorded cash'), 'fromCash', t('Cash withdrawn from accounts in this portfolio, minus deposits'))}
          {row(t('Dividends reinvested'), 'fromDiv', t('Dividends after tax, assumed reinvested'))}
          {fs[ccy].opening > 0.5 && row(t('Holdings owned before the records'), 'opening', t('Entered in the first week of the records: owned before, not bought this year'))}
          {row(t('Stock pay'), 'stockPay', t('Shares delivered to a stock-plan account (e.g. RSU vests at Morgan Stanley), at their value that day'))}
          {row(t('Cash from estimated salary'), 'salary', f.capped
            ? t('Held at the year before’s level: salary saved doesn’t jump from one year to the next')
            : t('What is left: money from outside the records, most likely salary saved'))}
          {f.savings > 0.5 && row(t('Other cash savings'), 'savings', t('Money from outside the records above the salary level: savings built up earlier'))}
          {row(t('Total bought (net of sales)'), 'net', '', true)}
        </tbody>
      </table>
      <p className="dr-dim">{t('Amounts in each currency use each date’s exchange rate.')}</p>
      <p><b>{t('How this was worked out.')}</b> {t('The app has no record of salary coming in, and buying does not draw down a cash account. So purchases are counted as paid first by cash taken from recorded accounts and by dividends. Shares that arrived in a stock-plan account are stock pay. The rest came from money the app never saw, and is shown as cash from estimated salary; anything more than 1.5 times the year before’s salary level is counted as other cash savings instead. Recording each salary deposit as cash would make this exact.')}</p>
      {f.unspent > 0 && <p>{t('{v} of cash was withdrawn but not invested during the year, so it left this portfolio’s records.', { v: fmt(f.unspent, ccy) })}</p>}
    </section>
  );
}

/**
 * Every year side by side: assets at each year's end (investments + cash) and each year's
 * profit or loss, split into investment profit and the exchange-rate effect. The year being
 * read is highlighted; clicking another year's bar opens its review.
 */
function YearByYear({ history, ccy, year, onYear }) {
  const rows = (history?.years || []).filter(y => y[ccy]);
  if (rows.length === 0) return null;
  const priors = salaryPriors(history, ccy);
  const data = rows.map((y, i) => {
    const prev = i > 0 ? rows[i - 1][ccy].assets : null;
    const chg = prev != null ? y[ccy].assets - prev : null;
    return {
      year: y.year,
      label: y.current ? t('{year} to date', { year: y.year }) : String(y.year),
      ...y[ccy],
      ...(() => { const f = funding({ ...y[ccy], cash: y[ccy].cash_flows }, priors.get(y.year) ?? null); return { stockPay: f.stockPay, salary: f.salary, savings: f.savings }; })(),
      chg, // assets compared with the year before
      chg_pct: prev ? chg / prev : null,
      fx_pct: y[ccy].return != null && y[ccy].investment_return != null ? y[ccy].return - y[ccy].investment_return : null,
    };
  });
  // A bar's label in two lines, the amount over its percentage: above a bar that goes up,
  // below one that goes down.
  const twoLine = (top, bottom, strong) => function TwoLine({ x, y, width, height, index }) {
    const d = data[index];
    const a = top(d), b = bottom(d);
    if (a == null) return null;
    const neg = (d[strong] ?? 0) < 0;
    const edge = neg ? Math.max(y, y + height) : Math.min(y, y + height);
    const cx = x + width / 2;
    const y1 = neg ? edge + 13 : edge - (b ? 19 : 6);
    return (
      <text x={cx} y={y1} textAnchor="middle" fontSize={11} fill="var(--text-dim)">
        <tspan x={cx} fill="var(--text)" fontWeight={600}>{a}</tspan>
        {b && <tspan x={cx} dy={13}>{b}</tspan>}
      </text>
    );
  };
  const tick = { fill: 'var(--text-dim)', fontSize: 12 };
  const axis = v => (v === 0 ? '0' : short(v, ccy).replace('+', ''));
  const pick = d => { if (d?.year != null && d.year !== year) onYear(d.year); };
  const dim = d => (d.year === year ? 1 : 0.45);
  const tip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="yy-tip">
        <strong>{d.label}</strong>
        <div>{t('Assets at year end')}: {fmt(d.assets, ccy)}</div>
        <div className="dr-dim">{t('Investments')} {fmt(d.securities, ccy)} · {t('Cash')} {fmt(d.cash, ccy)}</div>
        {d.chg != null && <div className={cls(d.chg)}>{t('Change from the year before')}: {signed(d.chg, ccy)} ({pct(d.chg_pct)})</div>}
        <div>{t('Stock pay')} {fmt(d.stockPay, ccy)} · {t('Cash from estimated salary')} {fmt(d.salary, ccy)}{d.savings > 0.5 ? ` · ${t('Other cash savings')} ${fmt(d.savings, ccy)}` : ''}</div>
        <div className={cls(d.investment)}>{t('Investment profit')}: {signed(d.investment, ccy)} ({pct(d.investment_return)})</div>
        <div className="yy-fx">{t('Exchange-rate effect')}: {signed(d.fx_effect, ccy)} ({pct(d.fx_pct)})</div>
        <div className={cls(d.profit)}><strong>{t('Total profit')}: {signed(d.profit, ccy)} ({pct(d.return)})</strong></div>
      </div>
    );
  };
  const first = data[0], last = data[data.length - 1];
  const growth = last.assets - first.assets;
  const earned = data.slice(1).reduce((s, d) => s + d.profit, 0);
  return (
    <section>
      <h2>{t('Year by year')}</h2>
      {data.length > 1 && (
        <p>{t('Assets went from {a} at the end of {y1} to {b} ({chg}). Profit in the years since accounts for {e} of that; the rest is money added or withdrawn.', {
          a: shortAbs(first.assets, ccy), y1: first.year, b: shortAbs(last.assets, ccy), chg: short(growth, ccy), e: short(earned, ccy),
        })}</p>
      )}
      <div className="yy-grid">
        <div>
          <h3 className="yy-title">{t('Assets at year end')}</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data} margin={{ top: 36, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={tick} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
              <YAxis tick={tick} tickFormatter={axis} axisLine={false} tickLine={false} width={64} />
              <Tooltip content={tip} cursor={{ fill: 'var(--hover)' }} />
              <Bar dataKey="securities" name={t('Investments')} stackId="a" fill="var(--accent)" onClick={pick} style={{ cursor: 'pointer' }}>
                {data.map(d => <Cell key={d.year} fillOpacity={dim(d) * 0.85} />)}
              </Bar>
              <Bar dataKey="cash" name={t('Cash')} stackId="a" fill="var(--text-dim)" radius={[3, 3, 0, 0]} onClick={pick} style={{ cursor: 'pointer' }}>
                {data.map(d => <Cell key={d.year} fillOpacity={dim(d) * 0.5} />)}
                <LabelList dataKey="assets" content={twoLine(d => shortAbs2(d.assets, ccy), d => (d.chg == null ? null : `${short2(d.chg, ccy)} · ${pct(d.chg_pct)}`), 'assets')} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="yy-legend">
            <span><i style={{ background: 'var(--accent)' }} />{t('Investments')}</span>
            <span><i style={{ background: 'var(--text-dim)', opacity: 0.6 }} />{t('Cash')}</span>
          </div>
        </div>
        <div>
          <h3 className="yy-title">{t('Profit or loss each year')}</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data} margin={{ top: 36, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={tick} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
              <YAxis tick={tick} tickFormatter={axis} axisLine={false} tickLine={false} width={64} />
              <ReferenceLine y={0} stroke="var(--text-dim)" />
              <Tooltip content={tip} cursor={{ fill: 'var(--hover)' }} />
              <Bar dataKey="investment" name={t('Investment profit')} onClick={pick} style={{ cursor: 'pointer' }}>
                {data.map(d => <Cell key={d.year} fill={d.investment < 0 ? 'var(--red)' : 'var(--green)'} fillOpacity={dim(d) * 0.8} />)}
                <LabelList dataKey="investment" content={twoLine(d => short(d.investment, ccy), d => pct(d.investment_return), 'investment')} />
              </Bar>
              <Bar dataKey="fx_effect" name={t('Exchange-rate effect')} fill="var(--amber)" onClick={pick} style={{ cursor: 'pointer' }}>
                {data.map(d => <Cell key={d.year} fillOpacity={dim(d) * 0.7} />)}
                <LabelList dataKey="fx_effect" content={twoLine(d => short(d.fx_effect, ccy), d => (d.fx_pct == null ? null : pct(d.fx_pct)), 'fx_effect')} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="yy-legend">
            <span><i style={{ background: 'var(--green)' }} /><i style={{ background: 'var(--red)' }} />{t('Investment profit')}</span>
            <span><i style={{ background: 'var(--amber)' }} />{t('Exchange-rate effect')}</span>
          </div>
        </div>
      </div>
      <table className="dr-table">
        <thead>
          <tr>
            <th>{t('Year')}</th>
            <th className="num">{t('Assets at year end')}</th>
            <th className="num">{t('Change from the year before')}</th>
            <th className="num">{t('Stock pay')}</th>
            <th className="num">{t('Cash from estimated salary')}</th>
            <th className="num">{t('Investment profit')}</th>
            <th className="num">{t('Exchange-rate effect')}</th>
            <th className="num">{t('Total profit')}</th>
          </tr>
        </thead>
        <tbody>
          {data.map(d => (
            <tr key={d.year} className={`yy-tr ${d.year === year ? 'yy-current' : 'yy-row'}`} onClick={() => pick(d)}>
              <td>{d.label}</td>
              <td className="num">{fmt(d.assets, ccy)}</td>
              <td className={`num ${cls(d.chg)}`}>{d.chg == null ? '–' : <>{signed(d.chg, ccy)}<small>{pct(d.chg_pct)}</small></>}</td>
              <td className="num">{fmt(d.stockPay, ccy)}</td>
              <td className="num">{fmt(d.salary, ccy)}{d.savings > 0.5 && <small>{t('+{v} other savings', { v: shortAbs(d.savings, ccy) })}</small>}</td>
              <td className={`num ${cls(d.investment)}`}>{signed(d.investment, ccy)}<small>{pct(d.investment_return)}</small></td>
              <td className="num">{signed(d.fx_effect, ccy)}{d.fx_pct != null && <small>{pct(d.fx_pct)}</small>}</td>
              <td className={`num ${cls(d.profit)}`}>{signed(d.profit, ccy)}<small>{pct(d.return)}</small></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dr-dim">{t('Assets include cash recorded in this portfolio, valued at each year’s Dec 31 rate (today’s for this year). Profit counts only the investments; money added or withdrawn is not profit. The change from the year before includes both. Percentages of profit are of the Dec 31 value plus purchases. Click a year to read its review.')}</p>
    </section>
  );
}

function ProfitTable({ review, ccys, ytd }) {
  const prev = review.year - 1;
  const row = (label, get, render = fmt, extra) => (
    <tr className={extra}>
      <td>{label}</td>
      {ccys.map(c => {
        const v = get(review.currencies[c]);
        const n = typeof v === 'number' ? v : v?.n;
        return <td key={c} className={`num ${render !== fmt ? cls(n) : ''}`}>{render(v, c)}</td>;
      })}
    </tr>
  );
  const withPct = (v, c) => `${signed(v.n, c)} (${pct(v.p)})`;
  const fx = review.fx;
  const fxMove = fx?.usd_start && fx?.usd_end ? fx.usd_end / fx.usd_start - 1 : null;
  const first = review.currencies[ccys[0]];
  const conclusion = Math.abs(first.fixed_fx.return ?? 0) < 0.01
    ? t('So the investments roughly broke even; the exchange rate decides whether the year looks like a gain or a loss.')
    : first.fixed_fx.profit > 0
      ? t('So the investments themselves gained {v}; the exchange rate is a separate effect on top.', { v: pct(first.fixed_fx.return) })
      : t('So the investments themselves lost {v}; the exchange rate is a separate effect on top.', { v: pct(first.fixed_fx.return) });
  return (
    <section>
      <h2>{t('YTD and YTD Profit')}</h2>
      {ytd?.sec != null && (
        <p>{t('The app’s YTD reads {ytd} ({cash} with cash): today’s holdings priced from Jan 1. What the money actually made is below, with the investment’s own result separated from the exchange rate.', { ytd: pct(ytd.sec), cash: pct(ytd.cash) })}</p>
      )}
      <table className="dr-table">
        <thead><tr><th>{periodOf(review)}</th>{ccys.map(c => <th key={c} className="num">{c}</th>)}</tr></thead>
        <tbody>
          {row(t('Value on Dec 31, {prev}', { prev }), x => x.start_value)}
          {row(t('Bought, net of sales'), x => x.bought - x.sold)}
          {row(review.current ? t('Value now') : t('Value on Dec 31, {year}', { year: review.year }), x => x.end_value)}
          <tr className="dr-subhead"><td colSpan={ccys.length + 1}>{t('Where the profit came from')}</td></tr>
          {row(t('Price change'), x => x.fixed_fx.price, signed)}
          {row(t('Dividends after tax'), x => x.fixed_fx.dividends, signed)}
          {row(t('Investment profit'), x => ({ n: x.fixed_fx.profit, p: x.fixed_fx.return }), withPct, 'dr-strong')}
          {row(t('Exchange-rate effect'), x => x.fx_effect, signed, 'dr-fx')}
          {row(review.current ? t('Total profit (YTD Profit)') : t('Total profit'), x => ({ n: x.profit, p: x.return }), withPct, 'dr-strong dr-total')}
        </tbody>
      </table>
      {fx?.usd_start && (
        <p className="dr-dim">{t('Investment profit holds every exchange rate at Dec 31, {prev} (USD/KRW {a}): what the holdings earned in their own markets. The exchange-rate effect is the rest, from USD/KRW moving to {b} ({chg}).', {
          prev, a: rate(fx.usd_start), b: rate(fx.usd_end), chg: pct(fxMove),
        })}</p>
      )}
      <p>{conclusion}</p>
    </section>
  );
}

function Drivers({ review, ccy }) {
  const r = review.currencies[ccy];
  const rows = r.by_symbol || [];
  if (!rows.length) return null;
  // Holdings by what their investment earned; the exchange rate gets its own bar at the end.
  const bars = [...rows.map(x => ({ key: x.symbol, label: x.symbol, v: x.investment, x })), { key: '__fx', label: t('Exchange rate'), v: r.fx_effect, fx: true }];
  const max = Math.max(...bars.map(b => Math.abs(b.v)), 1);
  const losers = rows.filter(x => x.investment < 0).reverse().slice(0, 2);
  const winners = rows.filter(x => x.investment > 0).slice(0, 3);
  const sum = xs => xs.reduce((s, x) => s + x.investment, 0);
  return (
    <section>
      <h2>{t('What drove the year')}</h2>
      <p>
        {winners.length > 0 && t('{list} earned {v}.', { list: listOf(winners.map(x => x.symbol)), v: shortAbs(sum(winners), ccy) })}{' '}
        {losers.length > 0 && t('{list} lost {v}.', { list: listOf(losers.map(x => x.symbol)), v: shortAbs(sum(losers), ccy) })}{' '}
        {t(r.fx_effect >= 0 ? 'Separately, the exchange rate added {v}.' : 'Separately, the exchange rate cost {v}.', { v: shortAbs(r.fx_effect, ccy) })}
      </p>
      <div className="yr-bars">
        {bars.map(b => {
          const w = `${(Math.abs(b.v) / max) * 50}%`;
          const tip = b.fx
            ? `${t('Exchange-rate effect')}: ${signed(b.v, ccy)}`
            : `${b.x.name}: ${t('Investment profit')} ${signed(b.v, ccy)} · ${t('Exchange-rate effect')} ${signed(b.x.fx, ccy)} · ${t('Total')} ${signed(b.x.profit, ccy)}`;
          return (
            <div key={b.key} className={`yr-bar-row${b.fx ? ' yr-fx-row' : ''}`} title={tip}>
              <span className="yr-name">{b.label}</span>
              <span className="yr-track">
                <span className={`yr-bar ${b.fx ? 'fx' : b.v < 0 ? 'neg' : 'pos'}`} style={b.v < 0 ? { right: '50%', width: w } : { left: '50%', width: w }} />
              </span>
              <span className={`yr-val ${cls(b.v)}`}>{short(b.v, ccy)}</span>
            </div>
          );
        })}
      </div>
      <p className="dr-dim">{t('Each holding’s investment profit (price change and dividends, exchange rate held at the start of the year). The exchange rate’s effect on all of them is the last bar. Hover a bar for the split.')}</p>
    </section>
  );
}

function Analysis({ review, ccy, base, ccys, fund }) {
  const r = review.currencies[ccy];
  const rows = r.by_symbol || [];
  const fxEffect = r.fx_effect;
  const fx = review.fx;
  const fxItem = fx?.usd_start && fx?.usd_end && Math.abs(fxEffect) > 0.01 * r.invested
    ? [t('Exchange rate'), t(fxEffect > 0 ? 'USD/KRW went from {a} to {b}, which added {v} in {ccy}.' : 'USD/KRW went from {a} to {b}, which cost {v} in {ccy}.', {
      a: rate(fx.usd_start), b: rate(fx.usd_end), v: shortAbs(fxEffect, ccy), ccy,
    })]
    : null;

  // Holdings are judged on what their investment earned; the exchange rate is its own item.
  const worked = rows.filter(x => x.investment > 0).slice(0, 3).map(x => [x.symbol, x.investment_dividends > 0.1 * x.investment
    ? t('{v}, of which {d} dividends.', { v: short(x.investment, ccy), d: shortAbs(x.investment_dividends, ccy) })
    : `${short(x.investment, ccy)}.`]);
  if (fxItem && fxEffect > 0) worked.push(fxItem);

  const didNot = rows.filter(x => x.investment < 0).reverse().slice(0, 3).map(x => [x.symbol, x.bought > x.start_value
    ? t('{v}; mostly bought during the year, at higher prices than now.', { v: short(x.investment, ccy) })
    : `${short(x.investment, ccy)}.`]);
  if (fxItem && fxEffect < 0) didNot.push(fxItem);

  const held = rows.filter(x => x.end_value > 0);
  const total = held.reduce((s, x) => s + x.end_value, 0);
  const watch = [];
  if (total > 0 && held.length > 3) {
    const top = [...held].sort((a, b) => b.end_value - a.end_value).slice(0, 3);
    const s = top.reduce((a, x) => a + x.end_value, 0) / total;
    if (s > 0.5) watch.push([t('Concentration'), t('{list} are {pct} of the holdings, so three positions drive most of the result.', { list: listOf(top.map(x => x.symbol)), pct: share(s) })]);
  }
  const usd = total > 0 ? held.filter(x => x.currency === 'USD').reduce((a, x) => a + x.end_value, 0) / total : 0;
  if (usd > 0.3) watch.push([t('Currency exposure'), t('{pct} is priced in dollars. In won terms, the result swings with USD/KRW.', { pct: share(Math.min(usd, 1)) })]);

  const records = [];
  const avgN = (review.checks || []).filter(c => c.status === 'average').length;
  const noPriceN = (review.checks || []).filter(c => c.status === 'no_price').length;
  if (avgN) records.push([t('Average prices'), t('{n} trades were entered at your average price from the Holdings card. This review counts them at that day’s close; recording the real purchase dates and prices would make that step unnecessary.', { n: avgN })]);
  if (noPriceN) records.push([t('Missing prices'), t('{n} trades have no market price on their date, so they count at the recorded price.', { n: noPriceN })]);
  const f = fund(ccy, r);
  if (f.salary > 0) records.push([t('Salary'), t('Salary deposits are not recorded, so {v} of cash from salary is an estimate: what is left after cash, dividends and stock pay, held to the year before’s level. Recording each salary deposit as cash would make it exact.', { v: shortAbs(f.salary, ccy) })]);
  if (f.unspent > 0) records.push([t('Cash'), t('{v} withdrawn during the year was not invested or recorded elsewhere.', { v: shortAbs(f.unspent, ccy) })]);

  const next = review.current ? review.year + 1 : null;
  const group = (title, items, empty, note) => (
    <>
      <h3>{title}{note && <span className="dr-note"> {note}</span>}</h3>
      {items.length ? <ul>{items.map(([b, text], i) => <li key={i}><b>{b}:</b> {text}</li>)}</ul> : <p className="dr-dim">{empty}</p>}
    </>
  );
  return (
    <section>
      <h2>{t('Analysis of the year')}</h2>
      <p>{t(fxEffect < 0
        ? 'Before the exchange rate, the investment choices made {f}. The exchange rate then cost {v} in {ccy}, for {a} in all.'
        : 'Before the exchange rate, the investment choices made {f}. The exchange rate then added {v} in {ccy}, for {a} in all.', {
        f: `${signed(r.fixed_fx.profit, ccy)} (${pct(r.fixed_fx.return)})`, v: shortAbs(fxEffect, ccy), ccy, a: result(r, ccy),
      })}</p>
      {group(t('What worked'), worked, t('No holding gained.'))}
      {group(t('What did not'), didNot, t('No holding lost money.'))}
      {group(t('Record keeping'), records, t('Records look consistent.'))}
      {watch.length > 0 && group(next ? t('Worth watching in {year}', { year: next }) : t('Worth noting'), watch, '', t('(observations, not advice)'))}
    </section>
  );
}

function Checks({ checks }) {
  if (!checks?.length) return null;
  const range = c => (c.low > 0 && c.high > 0 ? `${fmtPx(c.low, c.currency)} – ${fmtPx(c.high, c.currency)}` : '–');
  return (
    <section>
      <h2>{t('Trades counted at the day’s close')}</h2>
      <p>{t('These trades are recorded at a price outside that day’s trading range, which usually means an average price entered on the Holdings card. For the year’s profit they count at that day’s close; Cost Basis, Total Gain and Inception keep the recorded price.')}</p>
      <table className="dr-table">
        <thead>
          <tr>
            <th>{t('Date')}</th><th>{t('Account')}</th><th>{t('Trade')}</th><th className="num">{t('Shares')}</th>
            <th className="num">{t('Recorded price')}</th><th className="num">{t('Amount recorded')}</th>
            <th className="num">{t('Day’s range')}</th><th className="num">{t('Counted at (close)')}</th><th className="num">{t('Amount counted')}</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c, i) => (
            <tr key={i}>
              <td>{c.trade_date}</td>
              <td>{c.account || '–'}</td>
              <td>{t(c.side === 'buy' ? 'Buy' : 'Sell')} <b>{c.symbol}</b></td>
              <td className="num">{c.shares.toLocaleString(locale())}</td>
              <td className="num">{fmtPx(c.price, c.currency)}</td>
              <td className="num">{fmtPx(c.shares * c.price, c.currency)}</td>
              <td className="num">{range(c)}</td>
              <td className="num">{c.status === 'no_price' ? t('no price') : fmtPx(c.counted_at, c.currency)}</td>
              <td className="num">{fmtPx(c.shares * c.counted_at, c.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dr-dim">{t('A trade with no price on its date counts at the recorded price.')}</p>
    </section>
  );
}

function Method({ review }) {
  const end = Object.values(review.currencies)[0]?.end;
  return (
    <section>
      <h2>{t('Method and caveats')}</h2>
      <p>{t('Figures run from Jan 1 to {end} and come from this app’s own records.', { end: end ? dateLabel(end) : '' })}</p>
      <ul>
        <li><b>{t('Prices')}:</b> {t('daily closes stored by the app (Yahoo Finance; Naver for KRX gold). USD/KRW was {a} at the start and {b} at the end.', { a: rate(review.fx?.usd_start), b: rate(review.fx?.usd_end) })}</li>
        <li><b>{t('Dividends')}:</b> {t('Yahoo dividend records, counted for shares held before each ex-date, after withholding: 15% on US dividends, 15.4% on Korean ones, none in IRP, ISA and pension (연금) accounts.')}</li>
        <li><b>{t('Profit')}:</b> {t('value at the end − value on Dec 31 − net purchases + dividends. Each purchase is converted at its own date’s rate. The % is profit ÷ (Dec 31 value + purchases).')}</li>
        <li><b>{t('Exchange-rate effect')}:</b> {t('total profit minus the investment profit, which is the same year worked out with every exchange rate held at the start of the year.')}</li>
        <li>{t('Cash balances are left out of every return figure.')}</li>
        <li>{t('A record of what happened, not financial advice.')}</li>
      </ul>
    </section>
  );
}
