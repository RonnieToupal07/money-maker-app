import { setGlobalOptions } from 'firebase-functions/v2';

// Applies to every function exported below. Keep the region next to your Firestore database.
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

// Every function exported from this file gets deployed.
export { computeTradePnl, tradeSummary } from './trades.js';
export {
  checkForEntries,
  closingTradesSchedule,
  entryOrdersSchedule,
  fearGreedFetch,
  fearGreedReminder,
  getAutoTrading,
  getBlockedSignals,
  getFearGreed,
  ivSeriesSchedule,
  setAutoTrading,
  setFearGreed,
  tradeAlertsSchedule,
} from './entries.js';
export { schwabAuth, schwabConnectUrl, schwabOrderSync, syncSchwab } from './brokerage.js';
export { bxCancelOrder, bxCloseTrade, bxDailyScan, bxMarginDetail,bxOrderSync, bxPlaceOrder, bxScanNow, bxSync, bxTakeProfitCheck } from './bx.js';
