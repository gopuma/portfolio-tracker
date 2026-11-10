import { useEffect, useState } from 'react';
import RetirementCountdown from './RetirementCountdown.jsx';
import GoldGapPanel from './GoldGapPanel.jsx';
import BitcoinPanel from './BitcoinPanel.jsx';
import FxRateCard from './FxRateCard.jsx';
import VixCard from './VixCard.jsx';
import BackfillBar from './BackfillBar.jsx';
import IndexCards from './IndexCards.jsx';
import MarketHoursCard from './MarketHoursCard.jsx';

// The cards' stored-price histories are fetched when the page opens. A tab left open for
// days would keep showing the series as it was then, so reload them on this interval and
// when the tab comes back into view after a while.
const RELOAD_MS = 15 * 60_000;
const RELOAD_ON_VIEW_MS = 5 * 60_000;

/** A counter that ticks every RELOAD_MS while visible, and on return to the tab. */
function useReloadKey() {
  const [key, setKey] = useState(0);
  useEffect(() => {
    let last = Date.now();
    const bump = () => { last = Date.now(); setKey(k => k + 1); };
    const t = setInterval(() => { if (document.visibilityState === 'visible') bump(); }, RELOAD_MS);
    const onView = () => { if (document.visibilityState === 'visible' && Date.now() - last > RELOAD_ON_VIEW_MS) bump(); };
    document.addEventListener('visibilitychange', onView);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onView); };
  }, []);
  return [key, () => setKey(k => k + 1)];
}

// Market overview: price-update status and backfill control on top, US market hours in
// Seoul time, then major indices, FX,
// volatility, gold-gap and bitcoin.
// Per-instrument return/risk analytics now live on each portfolio's detail page.
export default function PortfolioOverview() {
  // Also bumped when a manual Backfill finishes, so the charts pick up what it fetched.
  const [reloadKey, reload] = useReloadKey();
  return (
    <>
      {/* Two short cards share one row (stacked on narrow screens by .grid-2). */}
      <div className="grid-2">
        <BackfillBar onDone={reload} />
        <RetirementCountdown />
      </div>

      <MarketHoursCard />

      <IndexCards />

      <FxRateCard reloadKey={reloadKey} />

      <FxRateCard symbol="JPYKRW=X" title="KRW / JPY Exchange Rate" unit="KRW per JPY" pairShort="KRW/JPY" reloadKey={reloadKey} />

      <VixCard reloadKey={reloadKey} />

      <GoldGapPanel reloadKey={reloadKey} />

      <BitcoinPanel reloadKey={reloadKey} />
    </>
  );
}
