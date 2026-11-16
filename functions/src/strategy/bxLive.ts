// The Bx-Trender seller's daily scan. The backtest decides on the day's close; this runs shortly
// before it and treats the latest price as the close, so a signal can differ by the final minutes.
//   bxDailyHistory/{TICKER}   split-adjusted daily bars for completed days, refreshed once a day
// The put EMA is 350 days, so this keeps far more history than dailyHistory does.
import { logger } from 'firebase-functions';
import { db } from '../admin.js';
import { BX, BX_TICKERS, BxDirection, EARLIEST_USABLE_DATE, SpyRegime } from './bxConfig.js';
import { Readings, entryReadings, entryScore, sizingPct, skipGroup } from './bxEntryScore.js';
import {
  bxScores,
  checkExit,
  contractsFor,
  daysBetween,
  detectSignal,
  houseMarginPct,
  perContractBuyingPower,
  pickContract,
  realizedVolatility,
  spyRegimeOf,
} from './bxRules.js';
import { dailyContext, DailyContext } from './daily.js';
import { fearGreedBefore, loadFearGreed } from './fearGreed.js';
import { addDays, isRegularHours } from './history.js';
import { ivBefore, ivSoFar, loadIvSeries } from './ivSeries.js';
import {
  DailyBar, getAggs30Min, getAggsDaily, getLiveOptionQuote, getOptionChainQuotes, getSharesOutstanding, LiveOptionQuote,
} from './massive.js';

export const BX_HISTORY_COLLECTION = 'bxDailyHistory';
const HISTORY_DAYS = 365 * 8;
const CONCURRENCY = 8;

async function loadBxHistory(ticker: string, today: string): Promise<DailyBar[]> {
  const ref = db.collection(BX_HISTORY_COLLECTION).doc(ticker);
  const stored = (await ref.get()).data() as { throughDate: string; bars: DailyBar[] } | undefined;
  const yesterday = addDays(today, -1);
  if (stored && stored.throughDate >= yesterday) return stored.bars.filter((b) => b.date < today);
  const earliest = EARLIEST_USABLE_DATE[ticker];
  const from = addDays(today, -HISTORY_DAYS);
  const bars = (await getAggsDaily(ticker, earliest && earliest > from ? earliest : from, yesterday)).filter((b) => b.date < today);
  await ref.set({ ticker, throughDate: yesterday, bars, updatedAt: new Date() });
  return bars;
}

/** Today's bar so far, built from the 30-min bars; null if the ticker hasn't traded today. */
async function todaysBar(ticker: string, today: string): Promise<DailyBar | null> {
  const bars = (await getAggs30Min(ticker, today, today)).filter(isRegularHours);
  if (!bars.length) return null;
  return {
    date: today,
    open: bars[0].open,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    close: bars[bars.length - 1].close,
    volume: bars.reduce((sum, b) => sum + b.volume, 0),
  };
}

interface TickerState {
  ticker: string;
  today: DailyBar;
  history: DailyContext;
  closes: number[];
  score: number | undefined;
}

async function loadTicker(ticker: string, day: string): Promise<TickerState | null> {
  const [bars, today] = await Promise.all([loadBxHistory(ticker, day), todaysBar(ticker, day)]);
  if (!today || bars.length < 30) return null;
  const closes = [...bars.map((b) => b.close), today.close];
  const scores = bxScores(closes);
  const score = scores[scores.length - 1];
  return { ticker, today, history: dailyContext(bars), closes, score: Number.isNaN(score) ? undefined : score };
}

async function pool<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

export interface BxCheck {
  ticker: string;
  direction: BxDirection;
  peakScore: number;
  spot: number;
  /** The entry score, once the contract is picked and the readings are in. */
  score: number | null;
  /** Why it isn't an entry; null for an entry. */
  blocked: string | null;
}

export interface BxEntry {
  ticker: string;
  direction: BxDirection;
  peakScore: number;
  spot: number;
  optionTicker: string;
  strike: number;
  expiration: string;
  dte: number;
  delta: number;
  closePrice: number;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  volume: number;
  iv: number | null;
  housePct: number;
  perContractBp: number;
  score: number;
  /** Share of the account value the score sizes it to. */
  sizingPct: number;
  spyRegime: SpyRegime | null;
  readings: Readings;
  /** Null until an account is connected to size against. */
  contracts: number | null;
}

export interface OpenBxTrade {
  id: string;
  ticker: string;
  direction: BxDirection;
  optionTicker: string;
  strike: number;
  expiration: string;
  entryDate: string;
  entryPrice: number;
  contracts: number;
  buyingPower: number;
  stopDelayDaysUsed: number;
}

export interface BxExit {
  trade: OpenBxTrade;
  reason: NonNullable<ReturnType<typeof checkExit>['reason']> | null;
  note: string;
  quote: LiveOptionQuote;
  mark: number | null;
  stopDelayDaysUsed: number;
}

export interface BxAccountInput {
  accountValue: number;
  availableFunds: number | null;
}

export interface BxScan {
  day: string;
  spyRegime: SpyRegime | null;
  checks: BxCheck[];
  entries: BxEntry[];
  exits: BxExit[];
  failed: string[];
}

/** The latest usable price of a contract: the mid, else its last trade. */
const markOf = (q: LiveOptionQuote) => q.midpoint ?? q.lastTradePrice;

/** One open trade's exit check at the contract's live price; `bxScore` feeds the hold rule. */
async function exitFor(trade: OpenBxTrade, day: string, bxScore: number | undefined): Promise<BxExit> {
  const quote = await getLiveOptionQuote(trade.optionTicker);
  const mark = markOf(quote);
  if (mark == null) return { trade, reason: null, note: 'no price for the contract', quote, mark, stopDelayDaysUsed: trade.stopDelayDaysUsed };
  if (day <= trade.entryDate) return { trade, reason: null, note: 'opened today', quote, mark, stopDelayDaysUsed: trade.stopDelayDaysUsed };
  const decision = checkExit({
    direction: trade.direction, entryPrice: trade.entryPrice, mark, dte: daysBetween(day, trade.expiration),
    bxScore, iv: ivBefore(await loadIvSeries(trade.ticker), day), stopDelayDaysUsed: trade.stopDelayDaysUsed,
  });
  return { trade, ...decision, quote, mark };
}

/**
 * The intraday check: each open trade's exit rules at its live price, every trade's verdict
 * included so a take profit that's no longer met can be withdrawn. The caller acts only on
 * take-profit exits: stop-loss and days-to-expiry stay with the daily scan, which judges them on
 * the close as the backtest does. Writes nothing.
 */
export async function checkTakeProfits(day: string, openTrades: OpenBxTrade[]): Promise<BxExit[]> {
  const exits: BxExit[] = [];
  await pool(openTrades, async (trade) => {
    try {
      const state = await loadTicker(trade.ticker, day);
      if (!state) return; // no trading in the stock today (holiday, halt): no live price to judge by
      exits.push(await exitFor(trade, day, state.score));
    } catch (err) {
      logger.warn(`${trade.optionTicker}: Bx take-profit check failed`, { error: (err as Error).message });
    }
  });
  return exits;
}

/** Runs every entry and exit rule for `day`. Reads market data only; it writes no suggestions. */
export async function scanBx(day: string, account: BxAccountInput | null, openTrades: OpenBxTrade[]): Promise<BxScan> {
  const [spy, fg] = await Promise.all([loadTicker('SPY', day), loadFearGreed()]);
  if (!spy) throw new Error(`No SPY bars for ${day} - market closed?`);
  const spyRegime = spyRegimeOf(spy.closes);

  const states = new Map<string, TickerState>();
  const failed: string[] = [];
  const tickers = [...new Set([...BX_TICKERS, ...openTrades.map((t) => t.ticker)])];
  await pool(tickers, async (ticker) => {
    try {
      const state = await loadTicker(ticker, day);
      if (state) states.set(ticker, state);
    } catch (err) {
      failed.push(ticker);
      logger.warn(`${ticker}: Bx scan failed`, { error: (err as Error).message });
    }
  });

  const checks: BxCheck[] = [];
  for (const state of states.values()) {
    const signal = detectSignal(bxScores(state.closes));
    if (!signal || !BX_TICKERS.includes(state.ticker)) continue;
    checks.push({ ticker: state.ticker, direction: signal.direction, peakScore: signal.peakScore, spot: state.today.close, score: null, blocked: null });
  }

  // Each signal's contract, readings and score, as the backtest takes them on the day's close.
  const spyBars = [...spy.history.bars, spy.today];
  const entries: BxEntry[] = [];
  await pool(checks, async (check) => {
    const state = states.get(check.ticker)!;
    try {
      const isPut = check.direction === 'sell_put', spot = state.today.close;
      const chain = await getOptionChainQuotes(
        state.ticker, isPut ? 'put' : 'call', addDays(day, BX.minDte), addDays(day, BX.maxDte),
        isPut ? spot * (1 - BX.maxOtmPct) : spot, isPut ? spot : spot * (1 + BX.maxOtmPct),
      );
      const approxIv = realizedVolatility(state.closes.slice(-31));
      const picked = pickContract(check.direction, day, spot, approxIv, chain);
      if (!picked) { check.blocked = 'no contract traded today in the delta, DTE and OTM window'; return; }
      const { contract } = picked;
      const [ivSeries, shares] = await Promise.all([loadIvSeries(state.ticker), getSharesOutstanding(state.ticker).catch(() => undefined)]);
      // Today's IV from the nearest-the-money call, else yesterday's reading.
      const ivToday = (await ivSoFar(state.ticker, day, spot).catch(() => undefined)) ?? ivBefore(ivSeries, day);
      const readings = entryReadings({
        day, bars: [...state.history.bars, state.today], spyBars, iv: ivSeries, ivToday,
        fearGreed: fearGreedBefore(fg, day)?.value, sharesOutstanding: shares, optionPrice: picked.price,
      });
      const score = entryScore(check.direction, readings);
      check.score = score;
      const skip = skipGroup(check.direction, readings);
      if (skip) { check.blocked = `in a skip group: ${skip}`; return; }
      const minScore = isPut ? BX.putMinScore : BX.callMinScore;
      if (score <= minScore) { check.blocked = `score ${score.toFixed(0)}, not above ${minScore}`; return; }
      if (contract.volume < 1) { check.blocked = 'no volume on the contract today'; return; }
      const quote = await getLiveOptionQuote(contract.ticker);
      const housePct = houseMarginPct(ivToday);
      entries.push({
        ticker: state.ticker, direction: check.direction, peakScore: check.peakScore, spot,
        optionTicker: contract.ticker, strike: contract.strikePrice, expiration: contract.expirationDate,
        dte: picked.dte, delta: picked.delta, closePrice: picked.price, bid: quote.bid, ask: quote.ask, midpoint: quote.midpoint,
        volume: contract.volume, iv: ivToday ?? null, housePct,
        perContractBp: perContractBuyingPower(check.direction, spot, contract.strikePrice, picked.price, housePct),
        score, sizingPct: sizingPct(check.direction, score), spyRegime: spyRegime ?? null, readings, contracts: null,
      });
    } catch (err) {
      check.blocked = `failed: ${(err as Error).message.slice(0, 100)}`;
    }
  });

  if (account) {
    // In the backtest's ticker order, each taking from what the ones before it left.
    const inUse = openTrades.reduce((sum, t) => sum + t.buyingPower, 0);
    const modelRoom = Math.max(account.accountValue - inUse, 0);
    let remaining = account.availableFunds != null ? Math.min(modelRoom, account.availableFunds) : modelRoom;
    for (const e of entries.sort((a, b) => BX_TICKERS.indexOf(a.ticker) - BX_TICKERS.indexOf(b.ticker))) {
      e.contracts = contractsFor({ accountValue: account.accountValue, remaining, pct: e.sizingPct, perContractBp: e.perContractBp, volume: e.volume });
      remaining -= e.contracts * e.perContractBp;
      if (e.contracts === 0) {
        const check = checks.find((c) => c.ticker === e.ticker);
        if (check) check.blocked = 'not enough buying power for 1 contract';
      }
    }
  }

  const exits: BxExit[] = [];
  await pool(openTrades, async (trade) => {
    try {
      exits.push(await exitFor(trade, day, states.get(trade.ticker)?.score));
    } catch (err) {
      failed.push(trade.ticker);
      logger.warn(`${trade.optionTicker}: Bx exit check failed`, { error: (err as Error).message });
    }
  });

  return { day, spyRegime: spyRegime ?? null, checks, entries: entries.filter((e) => e.contracts !== 0), exits, failed };
}
