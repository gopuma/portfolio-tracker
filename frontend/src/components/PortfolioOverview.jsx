import RetirementCountdown from './RetirementCountdown.jsx';
import GoldGapPanel from './GoldGapPanel.jsx';
import BitcoinPanel from './BitcoinPanel.jsx';
import FxRateCard from './FxRateCard.jsx';
import VixCard from './VixCard.jsx';
import BackfillBar from './BackfillBar.jsx';
import IndexCards from './IndexCards.jsx';

// Market overview: price-update status and backfill control on top, then major indices, FX,
// volatility, gold-gap and bitcoin.
// Per-instrument return/risk analytics now live on each portfolio's detail page.
export default function PortfolioOverview() {
  return (
    <>
      <BackfillBar />

      <RetirementCountdown />

      <IndexCards />

      <FxRateCard />

      <FxRateCard symbol="JPYKRW=X" title="KRW / JPY Exchange Rate" unit="KRW per JPY" pairShort="KRW/JPY" />

      <VixCard />

      <GoldGapPanel />

      <BitcoinPanel />
    </>
  );
}
