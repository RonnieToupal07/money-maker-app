// Ported from ~/Projects/money-maker/src/config.ts (config.tickers and
// config.macdexpCandleStrategy). Keep in sync when the backtest's parameters change.

export const CONTRACT_MULTIPLIER = 100;

/** A signal matching any of these gets the larger boostedCashCapPct (see the backtest's boostRules). */
export interface BoostRule {
  indicator: 'macdTrough' | 'macdSlope' | 'fearGreed' | 'relSpy20' | 'ivMinusHv' | 'sessionVwapSigma' | 'trend';
  min?: number;
  max?: number;
  equals?: 'belowBoth' | 'above50Only' | 'above200Only' | 'aboveBoth';
}

export const MACDEXP = {
  // MACD(12,26,9) reversal: the trough before the upturn within [troughMin, troughMax], the
  // smoothed RSI within [rsiMin, rsiMax] but outside [rsiSkipMin, rsiSkipMax], and the one-bar
  // upturn within [slopeMin, slopeMax].
  troughMin: -4,
  troughMax: 2,
  rsiLength: 14,
  rsiMaLength: 5,
  rsiMin: 0,
  rsiMax: 75,
  rsiSkipMin: 50 as number | null,
  rsiSkipMax: 70 as number | null,
  slopeMin: -1,
  slopeMax: 0.15,
  // Contract: the first Friday at least minDaysToExpiration days out, strike otmLow-otmHigh below
  // the signal close, closest to otmTarget; later Fridays out to maxDaysToExpiration when that
  // expiration has no strike in the band.
  otmLow: 0.01,
  otmHigh: 0.25,
  otmTarget: 0.065,
  minDaysToExpiration: 3,
  // Also the strategy-contract test: only long calls bought within this many days of their
  // expiration are strategy trades. Longer-dated contracts (and shorts) held in the same account
  // are never exit-checked, sold or sized against - they still count toward cash.
  maxDaysToExpiration: 40,
  // Exits: take profit once the option trades at least takeProfitMinGainPct above entry (a
  // resting limit sell placed as soon as the buy fills); force-close holdBars candles after the
  // signal candle; a contract expiring before then is held to expiration. No stop-loss.
  holdBars: 40,
  takeProfitMinGainPct: 0.17,
  minHoldBars: 0,
  // Position rules. 0 = no limit.
  maxTradesPerCandle: 0,
  onePerTicker: false,
  maxConcurrentOpen: 45,
  // Contracts: as many as cashCapPct of free cash buys (boostedCashCapPct for a signal matching
  // any boost rule), at most maxContracts, at most contractsPerAccountStep per accountStepValue of
  // account value, and at most the contracts traded in the 5-minute bar the price came from.
  cashCapPct: 0.15,
  boostedCashCapPct: 0.4 as number | null,
  boostRules: [
    { indicator: 'macdTrough', min: -6, max: -5 },
    { indicator: 'relSpy20', max: -10 },
    { indicator: 'macdTrough', min: -4, max: -3 },
    { indicator: 'ivMinusHv', min: 30 },
    { indicator: 'macdTrough', min: 1, max: 2 },
    { indicator: 'ivMinusHv', max: -30 },
    { indicator: 'trend', equals: 'above200Only' },
    { indicator: 'sessionVwapSigma', max: -2 },
    { indicator: 'macdSlope', min: 0.075 },
    { indicator: 'fearGreed', min: 20, max: 30 },
  ] as BoostRule[],
  maxContracts: 1000,
  contractsPerAccountStep: 2 as number | null,
  accountStepValue: 4000 as number | null,
  excludeTickers: ['SNDK'],
  // Entry filters, each from data before the signal candle's close. A missing reading (too little
  // history, no Fear & Greed or IV value within a week) lets the signal through, as in the backtest.
  // CNN Fear & Greed from the last trading day before the signal day: skip below fearGreedMin,
  // above fearGreedMax, or within [fearGreedSkipMin, fearGreedSkipMax].
  fearGreedMin: 15 as number | null,
  fearGreedSkipMin: 30 as number | null,
  fearGreedSkipMax: 60 as number | null,
  fearGreedMax: 80 as number | null,
  // Signal close vs the vwapDays-day VWAP of the daily bars before the signal day, in sigma.
  vwapDays: 20,
  vwapMinSigma: 0 as number | null,
  vwapMaxSigma: 2 as number | null,
  // IV rank (252-day, as of the day before the signal): skip within [ivRankSkipMin, ivRankSkipMax].
  ivRankSkipMin: 70 as number | null,
  ivRankSkipMax: 90 as number | null,
  // 52-week stochastic %K floor.
  stochK52Min: 20 as number | null,
  // Daily ADX(14) through the day before the signal must be above this.
  adxMin: 15 as number | null,
  // Skip signals closing below both the 50- and 200-day averages.
  skipTrendBelowBoth: false,
  // Skip signal candles trading more than this multiple of the same half-hour slot's 20-session average volume.
  rvolMax: 2 as number | null,
  // Signal candles (30-minute start time, ET, 24-hour "H:MM") that never open a trade.
  skipSignalCandles: ['13:00', '13:30', '14:00', '14:30'],
  // Entry fill: the option's last trade in the signal candle's final closeFillWindowMin minutes;
  // if it didn't trade there, the close of the first of the next entryFallback5MinBars 5-minute
  // bars that traded. Live, that's a buy limit at the bid/ask mid from the signal candle's close,
  // moved to the new mid every 5 minutes until it fills or the 200 bars run out.
  closeFillWindowMin: 5,
  entryFallback5MinBars: 200,
  // IV for the IV-rank series: Black-Scholes on the ~30-day near-the-money call's daily close.
  riskFreeRate: 0.045,
  dividendYield: 0,
};

export const TICKERS = [
  'TSLA', 'SPCX', 'META', 'GOOG', 'MSFT', 'NVDA', 'MU', 'AMD', 'IREN', 'AVGO', 'AAPL', 'MRVL',
  'ORCL', 'AMZN', 'CRM', 'CVNA', 'SHOP', 'HOOD', 'NFLX', 'DELL', 'APP', 'XYZ', 'INTC', 'PLTR',
  'COIN', 'MSTR', 'SMCI', 'QCOM', 'ARM', 'SOFI', 'BE', 'LITE', 'CRWV', 'SNDK', 'MARA', 'RIOT',
  'HUT', 'APLD', 'CORZ', 'NBIS', 'MDB', 'UBER', 'TSM', 'BA', 'COST', 'AMAT', 'LRCX', 'KLAC',
  'CSCO', 'IBM', 'ADBE', 'PYPL', 'NOW', 'PANW', 'ANET', 'BABA', 'DIS', 'GME', 'F', 'BAC', 'C',
  'GS', 'FCX', 'GE', 'CMG',
  'UNH', 'LLY', 'JNJ', 'PFE', 'ABBV', 'MRK',
  'XOM', 'CVX', 'SLB',
  'JPM', 'WFC', 'MS', 'SCHW', 'AXP', 'BLK', 'V', 'MA',
  'WMT', 'PG', 'KO', 'PEP',
  'CAT', 'DE', 'LMT', 'RTX', 'UPS',
  'T', 'VZ', 'TMUS',
  'CMCSA', 'WBD',
  'DAL', 'UAL',
  'TGT', 'HD', 'LOW', 'NKE',
  'GM',
  'BKNG',
  'AIG',
  'REGN', 'VRTX', 'GILD', 'AMGN', 'MRNA',
  'PLD', 'AMT', 'O',
  'NEE', 'DUK', 'SO',
  'LIN', 'DOW', 'APD', 'NUE',
  'MGM', 'WYNN', 'LVS', 'DKNG', 'CCL', 'RCL',
  'DHI', 'LEN',
  'CRWD', 'FTNT', 'ZS',
  'SNOW', 'DDOG', 'WDAY', 'TEAM',
  'PINS', 'SNAP', 'SPOT', 'ETSY',
  'DASH', 'ABNB', 'LCID',
  'ISRG', 'NOC', 'MO',
  'RDDT', 'CAVA', 'CART', 'ALAB', 'CRDO', 'IOT', 'RIVN', 'BIRK', 'CRCL', 'KVYO',
];
