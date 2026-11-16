// Rules for the Bx-Trender put/call seller, copied from ~/Projects/money-maker/src/config.ts
// (bxScoreSizedStrategy, the best checkpoint: output/checkpoints/bx-best-2026-11-16-exit17). An
// entry needs a points score above its side's minimum, from the points tables in data/, and is
// sized by that score. Unlike that backtest, sizing uses the real Schwab account value, with no
// yearly reset. Keep these, and the tables in data/, in step with the backtest.
import { TICKERS } from './config.js';

export type BxDirection = 'sell_put' | 'sell_call';
export type SpyRegime = 'aboveBoth' | 'above50Only' | 'above200Only' | 'belowBoth';

export const BX = {
  bxParams: { shortL1: 5, shortL2: 20, shortL3: 5 },
  callBandMin: 34,
  callBandMax: 48,
  putBandMin: 20,
  putBandMax: 70,

  minDte: 21,
  maxDte: 50,
  callTargetDelta: 0.3,
  putTargetDelta: 0.38,
  deltaTolerance: 0.05,
  maxOtmPct: 0.15,
  // The backtest fills at the option's close less this; premiumPctOfStock is read at that price.
  fillSlippagePct: 0.01,

  // Entry score: the sum of the points of every indicator group the entry falls in. An entry needs
  // more than the minimum, and none of its side's skip groups.
  putMinScore: 850,
  callMinScore: -250,
  putPointsFile: 'bx-entry-group-points.json',
  callPointsFile: 'bx-entry-group-points-calls.json',
  putAvoidFile: 'bx-put-avoid-worst9.json',
  callAvoidFile: 'bx-call-avoid-worst4.json',
  // marketCapSpy is the market cap grown by SPY from the entry to the backtest's last day, when SPY
  // closed at this; live entries are scaled the same way, so the cap groups mean the same thing.
  spyCloseAtPointsDate: 749.92,

  // A trade takes as many contracts as fit in minPct-maxPct of the account value by its score:
  // minPct at put[0] (call[0] for calls), in a straight line (power 1) to maxPct at put[1] (call[1])
  // and above. At least 1 when 1 fits, at most maxContracts, and no more than fit in the margin left
  // or the contract's volume today.
  sizing: { minPct: 0.1, maxPct: 0.35, put: [850, 1100] as [number, number], call: [-250, 0] as [number, number], power: 1, maxContracts: 10 },

  // Take profit (share of the premium kept) by days left: the first matching row wins, and days
  // outside every row use putTakeProfitPct / callTakeProfitPct.
  putTakeProfitByDte: [
    { minDte: 15, maxDte: 20, pct: 0.4 },
    { minDte: 20, maxDte: 24, pct: 0.3 },
    { minDte: 25, maxDte: 29, pct: 0.2 },
    { minDte: 30, maxDte: 34, pct: 0.18 },
    { minDte: 35, maxDte: 39, pct: 0.25 },
    { minDte: 40, maxDte: 45, pct: 0.3 },
  ],
  callTakeProfitByDte: [
    { minDte: 10, maxDte: 19, pct: 0.8 },
    { minDte: 20, maxDte: 29, pct: 0.4 },
    { minDte: 30, maxDte: 39, pct: 0.7 },
    { minDte: 40, maxDte: 50, pct: 0.4 },
  ],
  callTakeProfitPct: 0.44,
  putTakeProfitPct: 0.18,
  callStopLossPct: 2.2,
  putStopLossPct: 3,
  callExitAtDte: 10,
  putExitAtDte: 17,
  callNeverExitBxAbs: 19,
  putNeverExitBxAbs: 12,
  stopLossIvDelayThreshold: 0.5,
  stopLossIvDelayMaxDays: 1,
  stopLossNeverExitIv: 1,
  // Not in the backtest, which settles at intrinsic: a short option held to expiration can be
  // assigned, so a close is always suggested this close to expiry, even if a hold rule applies.
  expirationWarningDte: 1,

  spyFastEmaDays: 50,
  spySlowEmaDays: 200,
  // Schwab-style house margin: the first tier whose minIv the IV reaches replaces both the 20% of
  // underlying and 30% of strike rates when higher. Estimates - Schwab doesn't publish its rates.
  volatilityMarginTiers: [
    { minIv: 1.0, pct: 0.75 },
    { minIv: 0.8, pct: 0.5 },
    { minIv: 0.6, pct: 0.4 },
    { minIv: 0.4, pct: 0.3 },
  ],
  riskFreeRate: 0.045,
  dividendYield: 0,
};

// The backtest's 65 tickers (TSLA through CMG), the ones its points tables were built on.
export const BX_TICKERS = TICKERS.slice(0, TICKERS.indexOf('CMG') + 1);

/** Massive's history under these tickers before these dates is a different company. */
export const EARLIEST_USABLE_DATE: Record<string, string | undefined> = {
  APP: '2021-04-15',
  META: '2022-06-09',
  COIN: '2021-04-14',
  MRNA: '2018-12-07',
  WBD: '2022-04-11',
};
