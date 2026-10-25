/**
 * Routes each instrument to the right price source based on symbol.
 * Yahoo for everything except the synthetic `KRX-GOLD-SPOT`, which scrapes Naver
 * (Yahoo doesn't publish KRX 금현물 in KRW/g).
 */
import { fetchAndStorePrices as fetchYahoo } from './priceFetcher.js';
import { fetchAndStoreKrxGoldSpot } from './krxGoldFetcher.js';
import { fetchAndStoreUpbit, UPBIT_MARKETS } from './upbitFetcher.js';

export async function fetchAndStorePrices(instrument, days = 365) {
  if (instrument.symbol === 'KRX-GOLD-SPOT') {
    return fetchAndStoreKrxGoldSpot(instrument, days);
  }
  // Bitcoin in won from Upbit (BTC-USD, the global price, comes from Yahoo below).
  if (UPBIT_MARKETS[instrument.symbol]) {
    return fetchAndStoreUpbit(instrument, days);
  }
  return fetchYahoo(instrument, days);
}
