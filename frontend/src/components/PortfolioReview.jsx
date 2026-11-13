import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { t } from '../i18n.jsx';
import YearReview from './YearReview.jsx';

/**
 * A portfolio's year-end investment review on its own page (/portfolios/:id/review), opened
 * from the portfolio page's review button or its YTD Profit card. The year picked is kept
 * in the address (?year=2025), so a past year's review can be bookmarked and Back works.
 */
export default function PortfolioReview() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [review, setReview] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    Promise.all([api.portfolioById(id), api.portfolioYtdProfit(id)])
      .then(([p, r]) => { if (!cancelled) { setData(p); setReview(r); } })
      .catch(e => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [id]);

  if (err) return <div className="error">{t('Failed to load: {err}', { err })}</div>;
  if (!data || !review) return <div className="loading">{t('Loading…')}</div>;

  const asked = Number(params.get('year'));
  const year = review.years?.includes(asked) ? asked : review.year;
  const tot = data.totals || {};
  return (
    <>
      <div style={{ margin: '4px 0 12px' }}>
        <Link to={`/portfolios/${id}`}>← {data.name}</Link>
      </div>
      {review.currencies ? (
        <YearReview
          page portfolioId={id} portfolioName={data.name} initial={review} base={data.base_currency}
          ytd={{ sec: tot.return_ytd, cash: tot.return_ytd_with_cash }}
          year={year} onYear={y => setParams(y === review.year ? {} : { year: String(y) })}
        />
      ) : (
        <div className="panel">{t('No trades recorded for this portfolio yet.')}</div>
      )}
    </>
  );
}
