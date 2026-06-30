import GoldGapPanel from './GoldGapPanel.jsx';
import FxRateCard from './FxRateCard.jsx';
import VixCard from './VixCard.jsx';
import BackfillBar from './BackfillBar.jsx';
import IndexCards from './IndexCards.jsx';

// Market overview: major indices, FX, volatility, gold-gap, and the price backfill control.
// Per-instrument return/risk analytics now live on each portfolio's detail page.
export default function PortfolioOverview() {
  return (
    <>
      <IndexCards />

      <FxRateCard />

      <FxRateCard symbol="JPYKRW=X" title="KRW / JPY Exchange Rate" unit="KRW per JPY" pairShort="KRW/JPY" />

      <VixCard />

      <BackfillBar />

      <GoldGapPanel />
    </>
  );
}
