// Live entry and exit check for the MACDEXP weekly-call strategy. Ported from
// runMacdexpLiveCheck(), detectSignals(), priceAndMaybeAccept() and the exit loop in
// ~/Projects/money-maker/src/macdexpCandleBacktest.ts; the rules are the same, but history comes
// from Firestore (see history.ts, daily.ts, ivSeries.ts, fearGreed.ts) instead of the local .cache.
import { logger } from 'firebase-functions';
import { CONTRACT_MULTIPLIER, MACDEXP as S, TICKERS } from './config.js';
import {
  DailyContext,
  Trend,
  adxBefore,
  dailyContext,
  loadDailyHistory,
  realizedVol20,
  return20,
  rollingVwapSigma,
  stochK52,
  trendBefore,
} from './daily.js';
import { FearGreedSeries, fearGreedBefore, loadFearGreed } from './fearGreed.js';
import { addDays, etParts, isRegularHours, loadPriceHistory } from './history.js';
import { ema, rsi, sma } from './indicators.js';
import { IvSeries, ivBefore, ivRankBefore, loadIvSeries } from './ivSeries.js';
import {
  Bar30,
  ChainContract,
  LiveOptionQuote,
  getAggs30Min,
  getCallChain,
  getLastTradePrice,
  getLiveOptionQuote,
} from './massive.js';

// ~40 trading days of regular-hours bars (13/day). EMA(26) and Wilder RSI(14) converge to well
// under a cent of the full-history values within a few hundred bars, the MACD dips below zero
// many times in that window so the "armed" state matches the backtest's too, and RVOL needs the
// same half-hour slot on the 20 sessions before.
const HISTORY_DAYS = 60;
const CONCURRENCY = 8;
export const BAR_MS = 30 * 60 * 1000;
export const FIVE_MIN_MS = 5 * 60 * 1000;
const RTH_OPEN = 570; // 9:30 ET, in minutes
const RTH_CLOSE = 960; // 16:00 ET
const BARS_PER_DAY = (RTH_CLOSE - RTH_OPEN) / 30;

const fmt = (n: number, digits = 2) => n.toFixed(digits);
const usd = (n: number) => `$${n.toFixed(2)}`;

/** The first Friday strictly after `date` that is at least minDaysToExpiration days out. */
function nextFriday(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  let add = ((5 - d.getUTCDay() + 7) % 7) || 7;
  while (add < S.minDaysToExpiration) add += 7;
  return addDays(date, add);
}

interface EntryReading {
  troughValue: number;
  entryRsi: number;
  entrySlope: number;
}

/** Indicator values on the latest bar, and every entry rule they fail. */
export interface EntryDiagnostics {
  macd: number | null;
  macdPrev: number | null; // the trough candidate
  macdPrev2: number | null;
  armed: boolean;
  rsi: number | null;
  slope: number | null;
  failedRules: string[];
}

const rsiInSkipBand = (r: number) =>
  S.rsiSkipMin !== null && S.rsiSkipMax !== null && r >= S.rsiSkipMin && r <= S.rsiSkipMax;

/**
 * Same rules as detectSignals(): a local MACD(12,26,9) minimum followed by an upturn, armed only
 * after the MACD has been below zero since the last signal, with the trough within
 * [troughMin, troughMax], RSI(14)+SMA(5) within [rsiMin, rsiMax] and outside
 * [rsiSkipMin, rsiSkipMax], and the one-bar upturn within [slopeMin, slopeMax]. Evaluates the
 * last bar, returning the reading if the signal fires there.
 */
function evaluateEntry(rth: Bar30[]): { diagnostics: EntryDiagnostics; reading: EntryReading | null } {
  const close = rth.map((b) => b.close);
  const fastEma = ema(close, 12);
  const slowEma = ema(close, 26);
  const macd = close.map((_, i) => fastEma[i] - slowEma[i]);
  const rsiSmoothed = sma(rsi(close, S.rsiLength), S.rsiMaLength);
  const last = macd.length - 1;

  // Replay every earlier bar so `armed` reflects signals that already fired.
  let armed = false;
  for (let i = 2; i < last; i++) {
    const m = macd[i], mp = macd[i - 1], mp2 = macd[i - 2];
    if ([m, mp, mp2].some(Number.isNaN)) continue;
    if (m < 0) armed = true;
    if (
      armed && mp <= mp2 && m > mp && mp >= S.troughMin && mp <= S.troughMax &&
      rsiSmoothed[i] >= S.rsiMin && rsiSmoothed[i] <= S.rsiMax && !rsiInSkipBand(rsiSmoothed[i]) &&
      m - mp >= S.slopeMin && m - mp <= S.slopeMax
    ) {
      armed = false;
    }
  }

  const m = macd[last], mp = macd[last - 1], mp2 = macd[last - 2], r = rsiSmoothed[last];
  if (last < 2 || [m, mp, mp2, r].some((v) => v === undefined || Number.isNaN(v))) {
    return {
      diagnostics: { macd: null, macdPrev: null, macdPrev2: null, armed, rsi: null, slope: null, failedRules: ['not enough price history'] },
      reading: null,
    };
  }
  if (m < 0) armed = true;
  const slope = m - mp;
  const failedRules: string[] = [];
  if (!armed) failedRules.push("MACD hasn't dropped below 0 since its last signal");
  if (mp > mp2) failedRules.push(`prior bar isn't a trough (MACD rose ${fmt(mp2)} → ${fmt(mp)})`);
  if (m <= mp) failedRules.push(`MACD not turning up (${fmt(mp)} → ${fmt(m)})`);
  if (mp < S.troughMin || mp > S.troughMax) failedRules.push(`trough ${fmt(mp)} outside ${S.troughMin} to ${S.troughMax}`);
  if (r < S.rsiMin || r > S.rsiMax) failedRules.push(`RSI ${fmt(r, 1)} outside ${S.rsiMin}–${S.rsiMax}`);
  if (rsiInSkipBand(r)) failedRules.push(`RSI ${fmt(r, 1)} inside the ${S.rsiSkipMin}–${S.rsiSkipMax} skip band`);
  if (slope < S.slopeMin || slope > S.slopeMax) failedRules.push(`upturn ${fmt(slope)} outside ${S.slopeMin} to ${S.slopeMax}`);

  return {
    diagnostics: { macd: m, macdPrev: mp, macdPrev2: mp2, armed, rsi: r, slope, failedRules },
    reading: failedRules.length ? null : { troughValue: mp, entryRsi: r, entrySlope: slope },
  };
}

interface CandleBars {
  /** Regular-hours bars through the latest completed 30-min candle. */
  rth: Bar30[];
  candleTime: string | null; // open time of the latest completed candle
  price: number | null; // that candle's close
}

/**
 * History plus today's completed candles. Like the backtest, rules are judged on a candle's
 * actual close, so the still-forming candle the aggs endpoint also returns is dropped.
 *
 * With `preview`, the still-forming candle is kept instead, closed at the live last-trade price:
 * the pre-close run uses it to judge the day's last candle a few minutes early, while orders can
 * still fill today.
 */
async function loadBars(ticker: string, today: string, from: string, nowMs: number, preview: boolean): Promise<CandleBars> {
  const [history, todayBars, livePrice] = await Promise.all([
    loadPriceHistory(ticker, from, today),
    getAggs30Min(ticker, today, today),
    preview ? getLastTradePrice(ticker) : Promise.resolve(null),
  ]);
  const completed = todayBars.filter((b) => Date.parse(b.time) + BAR_MS <= nowMs);
  const bars = [...history, ...completed];
  if (livePrice != null) {
    const time = new Date(Math.floor(nowMs / BAR_MS) * BAR_MS).toISOString();
    const forming = todayBars.find((b) => b.time === time);
    bars.push(
      forming
        ? { ...forming, high: Math.max(forming.high, livePrice), low: Math.min(forming.low, livePrice), close: livePrice }
        : { time, open: livePrice, high: livePrice, low: livePrice, close: livePrice, volume: 0 },
    );
  }
  const rth = bars.filter(isRegularHours);
  const last = rth[rth.length - 1];
  return { rth, candleTime: last?.time ?? null, price: last?.close ?? null };
}

/** Fetches each input at most once per scan (a ticker can be checked for entry and exit, SPY for every signal). */
function memo<T>(fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const loaded = new Map<string, Promise<T>>();
  return (key) => {
    let v = loaded.get(key);
    if (!v) loaded.set(key, (v = fn(key)));
    return v;
  };
}

/** Readings behind the entry filters and boost rules, for the dashboard and the alert. */
export interface EntryFilters {
  fearGreed: number | null;
  fearGreedDate: string | null;
  vwapSigma: number | null;
  adx: number | null;
  trend: Trend | null;
  ivRank: number | null;
  stochK52: number | null;
  rvol: number | null;
  relSpy20: number | null;
  ivMinusHv: number | null;
  sessionVwapSigma: number | null;
}

export interface EntrySignal extends EntryReading {
  ticker: string;
  candleTime: string; // open time of the completed 30-min candle the signal fired on
  price: number; // that candle's close
  expiration: string;
  contractTicker: string | null;
  strike: number | null;
  otmPct: number | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  lastTradePrice: number | null;
  /** The live bid/ask midpoint: the entry order's first limit. null = no two-sided quote yet. */
  entryPrice: number | null;
  filters: EntryFilters;
  /** Index into MACDEXP.boostRules of the first rule this signal matches, or -1. */
  boostRule: number;
  /** Cash cap for sizing: boostedCashCapPct when a boost rule matches, else cashCapPct. */
  capPct: number;
  suggestedContracts: number | null;
  estimatedCost: number | null;
  /** Why the backtest's rules wouldn't take this one; null = actionable. */
  skipReason: string | null;
}

/** One ticker's entry check, whether or not it signalled. */
export interface EntryCheck extends EntryDiagnostics {
  ticker: string;
  /** enter = actionable; skip = signal blocked by a filter or position rule; no-entry = no signal. */
  status: 'enter' | 'skip' | 'no-entry' | 'failed';
  candleTime: string | null; // open time of the completed candle judged
  price: number | null; // its close
  /** Every reason this ticker won't be entered right now; empty when status is 'enter'. */
  reasons: string[];
  signal: EntrySignal | null;
}

export interface OpenTrade {
  id: string;
  ticker: string;
  strike: number;
  expiration: string; // YYYY-MM-DD
  contracts: number;
  entryPrice: number;
  openedAt: string; // ISO
  /** Open time of the signal candle, when the auto-trader opened it; holdBars counts from here. */
  signalTime: string | null;
}

/** One open trade's exit check. */
export interface ExitCheck {
  tradeId: string;
  ticker: string;
  strike: number;
  expiration: string;
  contracts: number;
  entryPrice: number;
  openedAt: string;
  optionTicker: string;
  candleTime: string | null; // open time of the completed candle judged
  price: number | null; // the stock's close on that candle
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  lastTradePrice: number | null;
  optionPrice: number | null; // live midpoint, else last trade
  unrealizedPnl: number | null;
  /** Take-profit price: entry × (1 + takeProfitMinGainPct). */
  takeProfitPrice: number;
  barsHeld: number | null; // 30-min candles closed since the signal candle
  holdBars: number;
  status: 'exit' | 'hold' | 'failed';
  exitType: 'take-profit' | 'forced' | 'expiration' | null;
  /** Why it exits (status 'exit') or why it doesn't (status 'hold'). */
  reasons: string[];
}

export interface ScanResult {
  asOf: string;
  scanned: number;
  candleTime: string | null; // open time of the latest completed candle across all tickers
  failed: string[];
  cashAvailable: number;
  openCount: number;
  maxConcurrentOpen: number;
  /** Tickers whose latest completed candle fired, after the filters and position rules. What the alerts send. */
  signals: EntrySignal[];
  entries: EntryCheck[];
  exits: ExitCheck[];
}

export interface AccountState {
  cashAvailable: number;
  /** Net liquidation value, for the account-scaled contract cap. */
  accountValue: number;
  openTickers: Set<string>;
  openTrades: OpenTrade[];
  /** Entries still waiting for their buy to fill: they hold a position slot, like the backtest. */
  pendingTickers: string[];
}

interface ScanInputs {
  today: string;
  from: string;
  bars: (ticker: string) => Promise<CandleBars>;
  daily: (ticker: string) => Promise<DailyContext>;
  iv: (ticker: string) => Promise<IvSeries | undefined>;
  fearGreed: () => Promise<FearGreedSeries>;
  nowMs: number;
  preview: boolean;
}

/** Signal candle's volume over the average of the same half-hour slot on the 20 sessions before. */
function rvolOf(rth: Bar30[], idx: number): number | undefined {
  const sig = etParts(rth[idx].time);
  let sum = 0, n = 0;
  for (let k = idx - 1; k >= 0 && n < 20; k--) {
    const e = etParts(rth[k].time);
    if (e.minutes === sig.minutes && e.date !== sig.date) { sum += rth[k].volume; n++; }
  }
  return n === 20 && sum > 0 ? rth[idx].volume / (sum / 20) : undefined;
}

/** The session's bars from the open through `idx` (the signal candle). */
function sessionBars(rth: Bar30[], idx: number): Bar30[] {
  const day = etParts(rth[idx].time).date;
  let k = idx;
  while (k > 0 && etParts(rth[k - 1].time).date === day) k--;
  return rth.slice(k, idx + 1);
}

/**
 * The backtest's entry filters, in its order, on the signal candle at the end of `rth`. Returns
 * the readings and the first rule that blocks the signal (undefined = it passes).
 */
async function applyFilters(ticker: string, rth: Bar30[], inputs: ScanInputs): Promise<{ filters: EntryFilters; blocked?: string }> {
  const idx = rth.length - 1;
  const candle = rth[idx];
  const day = etParts(candle.time).date;
  const price = candle.close;
  const [daily, iv, fg] = await Promise.all([inputs.daily(ticker), inputs.iv(ticker), inputs.fearGreed()]);
  const session = sessionBars(rth, idx);

  const fng = fearGreedBefore(fg, day);
  const ivNow = ivBefore(iv, day);
  const hv = realizedVol20(daily, day);
  let pv = 0, pv2 = 0, vol = 0;
  for (const b of session) { const tp = (b.high + b.low + b.close) / 3; pv += tp * b.volume; pv2 += tp * tp * b.volume; vol += b.volume; }
  const vw = vol > 0 ? pv / vol : 0, vsd = vol > 0 ? Math.sqrt(Math.max(0, pv2 / vol - vw * vw)) : 0;
  let relSpy20: number | null = null;
  try {
    const stockRet = return20(daily, day, price);
    const [spyBars, spyDaily] = await Promise.all([inputs.bars('SPY'), inputs.daily('SPY')]);
    const spyNow = spyBars.rth.find((b) => b.time === candle.time)?.close;
    const spyRet = spyNow !== undefined ? return20(spyDaily, day, spyNow) : undefined;
    if (stockRet !== undefined && spyRet !== undefined) relSpy20 = (stockRet - spyRet) * 100;
  } catch (err) {
    logger.warn('SPY bars unavailable for the relative-strength boost rule', { error: (err as Error).message });
  }
  const nz = <T>(v: T | undefined) => (v === undefined ? null : v);
  const filters: EntryFilters = {
    fearGreed: fng?.value ?? null,
    fearGreedDate: fng?.date ?? null,
    vwapSigma: nz(rollingVwapSigma(daily, day, price, S.vwapDays)),
    adx: nz(adxBefore(daily, day)),
    trend: nz(trendBefore(daily, day, price)),
    ivRank: nz(ivRankBefore(iv, day)),
    stochK52: nz(stochK52(daily, day, price, Math.max(...session.map((b) => b.high)), Math.min(...session.map((b) => b.low)))),
    rvol: nz(rvolOf(rth, idx)),
    relSpy20,
    ivMinusHv: ivNow !== undefined && hv !== undefined ? ivNow * 100 - hv * 100 : null,
    sessionVwapSigma: vsd > 1e-9 ? (price - vw) / vsd : null,
  };

  const f = filters;
  const block = (): string | undefined => {
    if (f.fearGreed !== null) {
      if (S.fearGreedMin !== null && f.fearGreed < S.fearGreedMin) return `Fear & Greed ${f.fearGreed} below ${S.fearGreedMin}`;
      if (S.fearGreedMax !== null && f.fearGreed > S.fearGreedMax) return `Fear & Greed ${f.fearGreed} above ${S.fearGreedMax}`;
      if (S.fearGreedSkipMin !== null && S.fearGreedSkipMax !== null && f.fearGreed >= S.fearGreedSkipMin && f.fearGreed <= S.fearGreedSkipMax) {
        return `Fear & Greed ${f.fearGreed} inside ${S.fearGreedSkipMin}–${S.fearGreedSkipMax}`;
      }
    }
    if (f.vwapSigma !== null) {
      if (S.vwapMinSigma !== null && f.vwapSigma < S.vwapMinSigma) return `${fmt(f.vwapSigma)}σ from the ${S.vwapDays}-day VWAP, below ${S.vwapMinSigma}σ`;
      if (S.vwapMaxSigma !== null && f.vwapSigma > S.vwapMaxSigma) return `${fmt(f.vwapSigma)}σ from the ${S.vwapDays}-day VWAP, above ${S.vwapMaxSigma}σ`;
    }
    if (S.adxMin !== null && f.adx !== null && f.adx <= S.adxMin) return `daily ADX ${fmt(f.adx, 1)} at or below ${S.adxMin}`;
    if (S.skipTrendBelowBoth && f.trend === 'belowBoth') return 'below both the 50- and 200-day averages';
    if (S.ivRankSkipMin !== null && S.ivRankSkipMax !== null && f.ivRank !== null && f.ivRank >= S.ivRankSkipMin && f.ivRank <= S.ivRankSkipMax) {
      return `IV rank ${fmt(f.ivRank, 0)} inside ${S.ivRankSkipMin}–${S.ivRankSkipMax}`;
    }
    if (S.stochK52Min !== null && f.stochK52 !== null && f.stochK52 < S.stochK52Min) return `52-week %K ${fmt(f.stochK52, 0)} below ${S.stochK52Min}`;
    const m = etParts(candle.time).minutes, hhmm = `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    if (S.skipSignalCandles.includes(hhmm)) return `signal candle at ${hhmm} ET is skipped`;
    if (S.rvolMax !== null && f.rvol !== null && f.rvol > S.rvolMax) return `RVOL ${fmt(f.rvol, 1)}× above ${S.rvolMax}×`;
    return undefined;
  };
  return { filters, blocked: block() };
}

/** Index of the first boost rule the signal matches, or -1 (same as the backtest's matchBoost). */
function matchBoost(reading: EntryReading, f: EntryFilters): number {
  const values: Record<string, number | string | null> = {
    macdTrough: reading.troughValue,
    macdSlope: reading.entrySlope,
    fearGreed: f.fearGreed,
    relSpy20: f.relSpy20,
    ivMinusHv: f.ivMinusHv,
    sessionVwapSigma: f.sessionVwapSigma,
    trend: f.trend,
  };
  return S.boostRules.findIndex((rule) => {
    const v = values[rule.indicator];
    if (v === null || v === undefined) return false;
    if (rule.indicator === 'trend') return v === rule.equals;
    return typeof v === 'number' && (rule.min === undefined || v >= rule.min) && (rule.max === undefined || v < rule.max);
  });
}

/**
 * The backtest's contract: the first Friday at least minDaysToExpiration out, strike otmLow-otmHigh
 * below the signal close and closest to otmTarget; if that Friday has no strike in the band, each
 * later one out to maxDaysToExpiration.
 */
async function pickContract(ticker: string, day: string, price: number): Promise<{ expiration: string; contract?: ChainContract }> {
  const inBand = (c: ChainContract) => {
    const below = (price - c.strikePrice) / price;
    return below >= S.otmLow && below <= S.otmHigh;
  };
  const first = nextFriday(day);
  for (let exp = first; (Date.parse(exp) - Date.parse(day)) / 86_400_000 <= S.maxDaysToExpiration; exp = addDays(exp, 7)) {
    const band = (await getCallChain(ticker, exp)).filter(inBand);
    if (band.length) {
      const target = price * (1 - S.otmTarget);
      return { expiration: exp, contract: band.reduce((a, b) => (Math.abs(b.strikePrice - target) < Math.abs(a.strikePrice - target) ? b : a)) };
    }
  }
  return { expiration: first };
}

async function checkTicker(ticker: string, inputs: ScanInputs): Promise<EntryCheck> {
  let bars: CandleBars;
  try {
    bars = await inputs.bars(ticker);
  } catch (err) {
    logger.warn(`${ticker}: failed to fetch stock data`, { error: (err as Error).message });
    return {
      ticker, status: 'failed', candleTime: null, price: null,
      macd: null, macdPrev: null, macdPrev2: null, armed: false, rsi: null, slope: null, failedRules: [],
      reasons: ["couldn't fetch stock data"], signal: null,
    };
  }

  const { diagnostics, reading } = evaluateEntry(bars.rth);
  const check: EntryCheck = {
    ticker, status: 'no-entry', candleTime: bars.candleTime, price: bars.price, ...diagnostics, reasons: [], signal: null,
  };
  if (!reading || bars.candleTime == null || bars.price == null) return check;

  const { price, candleTime } = bars;
  const day = etParts(candleTime).date;
  let filters: EntryFilters;
  let blocked: string | undefined;
  try {
    ({ filters, blocked } = await applyFilters(ticker, bars.rth, inputs));
  } catch (err) {
    logger.warn(`${ticker}: failed to load filter data`, { error: (err as Error).message });
    return { ...check, status: 'failed', reasons: ["couldn't load the daily / IV / Fear & Greed data for the entry filters"] };
  }
  const boostRule = matchBoost(reading, filters);
  const capPct = boostRule >= 0 && S.boostedCashCapPct !== null ? S.boostedCashCapPct : S.cashCapPct;

  const signal: EntrySignal = {
    ticker, candleTime, price, ...reading, expiration: nextFriday(day),
    contractTicker: null, strike: null, otmPct: null, bid: null, ask: null, midpoint: null, lastTradePrice: null,
    entryPrice: null, filters, boostRule, capPct,
    suggestedContracts: null, estimatedCost: null, skipReason: blocked ?? null,
  };
  check.signal = signal;
  if (blocked) return check;

  try {
    const { expiration, contract } = await pickContract(ticker, day, price);
    signal.expiration = expiration;
    if (!contract) {
      signal.skipReason = `no strike ${S.otmLow * 100}–${S.otmHigh * 100}% below the stock within ${S.maxDaysToExpiration} days`;
      return check;
    }
    signal.contractTicker = contract.ticker;
    signal.strike = contract.strikePrice;
    signal.otmPct = (price - contract.strikePrice) / price;
    const quote = await getLiveOptionQuote(contract.ticker).catch((): LiveOptionQuote | undefined => undefined);
    if (quote) Object.assign(signal, quote);
    signal.entryPrice = quote?.midpoint ?? null;
  } catch (err) {
    logger.warn(`${ticker}: failed to fetch the option chain or prices`, { error: (err as Error).message });
    signal.skipReason = "couldn't fetch the option chain or prices";
  }
  return check;
}

/**
 * Contracts for an entry at `price`: as many as capPct of free cash buys, at most maxContracts,
 * and at most contractsPerAccountStep per accountStepValue of account value - the backtest's
 * sizing, without its traded-volume cap (a mid-price limit isn't tied to a traded bar). A string = why not.
 */
export function sizeEntry(price: number, capPct: number, cash: number, accountValue: number): number | string {
  const cost = price * CONTRACT_MULTIPLIER;
  if (!(cost > 0)) return 'no option price';
  const maxByPct = Math.floor((capPct * cash - 1e-6) / cost);
  if (maxByPct < 1) return `one contract (${usd(cost)}) costs more than ${(capPct * 100).toFixed(0)}% of free cash (${usd(cash)})`;
  let contracts = Math.min(maxByPct, S.maxContracts);
  if (S.contractsPerAccountStep !== null && S.accountStepValue !== null && S.accountStepValue > 0) {
    const accountCap = Math.floor((accountValue * S.contractsPerAccountStep) / S.accountStepValue);
    if (accountCap < 1) return `account value ${usd(accountValue)} is under ${usd(S.accountStepValue / S.contractsPerAccountStep)}, the account-scaled cap allows 0 contracts`;
    contracts = Math.min(contracts, accountCap);
  }
  if (cost * contracts > cash) return 'not enough free cash';
  return contracts;
}

/**
 * Applies the backtest's acceptance rules to this candle's signals: at most maxTradesPerCandle
 * (deepest trough first), one position per ticker if onePerTicker, at most maxConcurrentOpen open
 * or waiting to fill, and contracts sized by sizeEntry. Each accepted signal uses up cash and a
 * slot for the next. A signal without a two-sided quote yet is accepted without a size: the
 * entry order manager sizes it at the first mid it can buy at.
 */
function applyPositionRules(signals: EntrySignal[], account: AccountState): void {
  signals.sort((a, b) => a.troughValue - b.troughValue);
  let cash = account.cashAvailable;
  let openCount = account.openTrades.length + account.pendingTickers.length;
  const held = new Set([...account.openTickers, ...account.pendingTickers]);
  const perCandle = new Map<string, number>();

  for (const s of signals) {
    if (s.skipReason) continue;
    const opened = perCandle.get(s.candleTime) ?? 0;
    if (S.maxTradesPerCandle > 0 && opened >= S.maxTradesPerCandle) {
      s.skipReason = `${S.maxTradesPerCandle} trades already opened on this candle (shallower trough)`;
      continue;
    }
    if (S.maxConcurrentOpen > 0 && openCount >= S.maxConcurrentOpen) {
      s.skipReason = `${S.maxConcurrentOpen} positions already open or waiting to fill`;
      continue;
    }
    if (S.onePerTicker && held.has(s.ticker)) {
      s.skipReason = `already holding ${s.ticker}`;
      continue;
    }
    if (s.entryPrice != null) {
      const sized = sizeEntry(s.entryPrice, s.capPct, cash, account.accountValue);
      if (typeof sized === 'string') {
        s.skipReason = sized;
        continue;
      }
      s.suggestedContracts = sized;
      s.estimatedCost = sized * s.entryPrice * CONTRACT_MULTIPLIER;
    } else {
      // Not priced yet: reserve what the live quote suggests, so later signals this candle don't spend it.
      const guess = s.lastTradePrice ?? s.midpoint;
      const sized = guess != null ? sizeEntry(guess, s.capPct, cash, account.accountValue) : null;
      s.estimatedCost = typeof sized === 'number' ? sized * guess! * CONTRACT_MULTIPLIER : null;
    }
    cash -= s.estimatedCost ?? 0;
    openCount++;
    held.add(s.ticker);
    perCandle.set(s.candleTime, opened + 1);
  }
}

/** Position rules that block a ticker before its indicators even matter. */
function accountBlockers(ticker: string, account: AccountState): string[] {
  const blockers: string[] = [];
  if (S.maxConcurrentOpen > 0 && account.openTrades.length + account.pendingTickers.length >= S.maxConcurrentOpen) {
    blockers.push(`${S.maxConcurrentOpen} positions already open or waiting to fill`);
  }
  if (S.onePerTicker && (account.openTickers.has(ticker) || account.pendingTickers.includes(ticker))) blockers.push(`already holding ${ticker}`);
  if (account.cashAvailable <= 0) blockers.push('no free cash');
  return blockers;
}

/** OCC option symbol, e.g. TSLA 2026-10-23 $400 call → O:TSLA261023C00400000. */
export function callTicker(ticker: string, expiration: string, strike: number): string {
  const yymmdd = expiration.slice(2).replaceAll('-', '');
  return `O:${ticker}${yymmdd}C${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

/** Weekdays after `from` up to and including `to` (market holidays aren't known here). */
function weekdaysBetween(from: string, to: string): number {
  let count = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
    const day = new Date(d + 'T00:00:00Z').getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

/** The take-profit sell price for an entry: at least takeProfitMinGainPct above it (any gain when 0). */
export const takeProfitPrice = (entryPrice: number) => entryPrice * (1 + S.takeProfitMinGainPct);

/**
 * The backtest's exit rules for one open trade, judged at the latest completed candle's close:
 * take profit once the option is worth at least takeProfitMinGainPct more than entry (live, a
 * resting sell order does this between candles), force-close holdBars candles after the signal
 * candle, and a contract expiring before the forced exit is held to expiration and settles at intrinsic.
 */
async function checkExit(trade: OpenTrade, load: (ticker: string) => Promise<CandleBars>, today: string): Promise<ExitCheck> {
  const optionTicker = callTicker(trade.ticker, trade.expiration, trade.strike);
  const target = takeProfitPrice(trade.entryPrice);
  const check: ExitCheck = {
    tradeId: trade.id, ticker: trade.ticker, strike: trade.strike, expiration: trade.expiration,
    contracts: trade.contracts, entryPrice: trade.entryPrice, openedAt: trade.openedAt, optionTicker,
    candleTime: null, price: null,
    bid: null, ask: null, midpoint: null, lastTradePrice: null, optionPrice: null, unrealizedPnl: null,
    takeProfitPrice: target, barsHeld: null, holdBars: S.holdBars, status: 'hold', exitType: null, reasons: [],
  };

  let bars: CandleBars;
  try {
    bars = await load(trade.ticker);
  } catch (err) {
    logger.warn(`${trade.ticker}: failed to fetch stock data for exit check`, { error: (err as Error).message });
    return { ...check, status: 'failed', reasons: ["couldn't fetch stock data"] };
  }
  if (bars.candleTime == null || bars.price == null) {
    return { ...check, status: 'failed', reasons: ['no completed candles in the loaded price history'] };
  }
  check.candleTime = bars.candleTime;
  check.price = bars.price;

  try {
    const quote = await getLiveOptionQuote(optionTicker);
    Object.assign(check, quote);
    check.optionPrice = quote.midpoint ?? quote.lastTradePrice;
  } catch (err) {
    logger.warn(`${optionTicker}: failed to fetch option quote`, { error: (err as Error).message });
  }
  const px = check.optionPrice;
  if (px != null) check.unrealizedPnl = (px - trade.entryPrice) * trade.contracts * CONTRACT_MULTIPLIER;

  // holdBars counts from the signal candle, as in the backtest (a late fill doesn't extend it).
  // Trades without one (entered by hand) count from the candle whose close is nearest the open.
  let entryIdx = trade.signalTime ? bars.rth.findIndex((b) => b.time === trade.signalTime) : -1;
  if (entryIdx < 0) {
    const openedMs = Date.parse(trade.openedAt);
    entryIdx = bars.rth.length - 1;
    while (entryIdx >= 0 && Date.parse(bars.rth[entryIdx].time) + BAR_MS > openedMs + BAR_MS / 2) entryIdx--;
  }
  if (entryIdx < 0) return { ...check, status: 'failed', reasons: ['entry candle is older than the loaded price history'] };
  const barsHeld = bars.rth.length - 1 - entryIdx;
  check.barsHeld = barsHeld;

  const intrinsic = Math.max(bars.price - trade.strike, 0);
  const exit = (exitType: ExitCheck['exitType'], reason: string): ExitCheck => ({
    ...check, status: 'exit', exitType, reasons: [reason],
  });

  if (trade.expiration < today) return exit('expiration', `expired ${trade.expiration} — settles at intrinsic ${usd(intrinsic)}`);

  // Does the contract expire before the forced exit? (The backtest compares the two dates.) Before
  // today's first candle closes, the latest candle is a previous day's, so all of today is left.
  const candle = etParts(bars.candleTime);
  const barsLeftToday = candle.date < today ? BARS_PER_DAY : (RTH_CLOSE - candle.minutes - 30) / 30;
  const barsUntilExpiryClose = barsLeftToday + BARS_PER_DAY * weekdaysBetween(today, trade.expiration);
  const barsLeft = S.holdBars - barsHeld;
  const heldToExpiry = barsLeft > barsUntilExpiryClose;

  const takeProfitEligible = barsHeld >= 1 && barsHeld > S.minHoldBars && barsHeld < S.holdBars;
  if (takeProfitEligible && px != null && px >= target) {
    return exit('take-profit', `option ${usd(px)} at or above the take-profit ${usd(target)} (+${(S.takeProfitMinGainPct * 100).toFixed(0)}%)`);
  }
  if (!heldToExpiry && barsHeld >= S.holdBars) {
    return exit('forced', `held ${barsHeld} of ${S.holdBars} candles — forced exit at market`);
  }
  if (heldToExpiry && trade.expiration === today && barsLeftToday === 0) {
    return exit('expiration', `expires today, last candle — settles at intrinsic ${usd(intrinsic)} (stock − strike)`);
  }

  const reasons: string[] = [];
  if (barsHeld < 1 || barsHeld <= S.minHoldBars) reasons.push('entered on this candle — take profit starts from the next candle');
  else if (px == null) reasons.push('no live option price');
  else reasons.push(`option ${usd(px)} below the take-profit ${usd(target)} (+${(S.takeProfitMinGainPct * 100).toFixed(0)}% over entry ${usd(trade.entryPrice)})`);
  reasons.push(
    heldToExpiry
      ? `expires ${trade.expiration}, before the ${S.holdBars}-candle limit — held to expiration (intrinsic ${usd(intrinsic)} now)`
      : `${barsHeld} of ${S.holdBars} candles held — forced exit in ${barsLeft}`,
  );
  return { ...check, status: 'hold', reasons };
}

async function mapConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const STATUS_ORDER: Record<EntryCheck['status'], number> = { enter: 0, skip: 1, 'no-entry': 2, failed: 3 };

function scanInputs(now: Date, preview = false): ScanInputs {
  const nowMs = now.getTime();
  const today = etParts(now).date;
  const from = etParts(new Date(nowMs - HISTORY_DAYS * 24 * 60 * 60 * 1000)).date;
  let fg: Promise<FearGreedSeries> | undefined;
  return {
    today, from, nowMs, preview,
    bars: memo((t) => loadBars(t, today, from, nowMs, preview)),
    daily: memo(async (t) => dailyContext(await loadDailyHistory(t, today))),
    iv: memo((t) => loadIvSeries(t)),
    fearGreed: () => (fg ??= loadFearGreed()),
  };
}

/** Runs only the exit check on every open trade. */
export async function scanForExits(account: AccountState): Promise<ExitCheck[]> {
  const inputs = scanInputs(new Date());
  return mapConcurrent(account.openTrades, (t) => checkExit(t, inputs.bars, inputs.today));
}

/**
 * Runs the entry check on every ticker's latest completed candle and, unless `withExits` is
 * false, the exit check on every open trade. Every call fetches fresh data. With `preview`, the
 * still-forming candle is judged instead, closed at each ticker's live price (see loadBars).
 */
export async function scanForEntries(
  account: AccountState,
  { withExits = true, preview = false } = {},
): Promise<ScanResult> {
  const now = new Date();
  const inputs = scanInputs(now, preview);
  const excluded = new Set(S.excludeTickers);
  const tickers = TICKERS.filter((t) => !excluded.has(t));

  const entries = await mapConcurrent(tickers, (t) => checkTicker(t, inputs));
  const exits = withExits ? await mapConcurrent(account.openTrades, (t) => checkExit(t, inputs.bars, inputs.today)) : [];

  // Only the latest candle counts. A ticker whose newest bar is older (no trades in that
  // candle, or the API hasn't published it yet) can't signal on stale data.
  const candleTime = entries.reduce<string | null>((latest, e) => (e.candleTime && (!latest || e.candleTime > latest) ? e.candleTime : latest), null);
  const stale = (e: EntryCheck) => e.candleTime != null && e.candleTime !== candleTime;
  for (const e of entries) if (stale(e)) e.signal = null;

  const signals = entries.flatMap((e) => (e.signal ? [e.signal] : []));
  applyPositionRules(signals, account);

  for (const e of entries) {
    if (e.status === 'failed') continue;
    if (e.signal) {
      e.status = e.signal.skipReason ? 'skip' : 'enter';
      e.reasons = e.signal.skipReason ? [e.signal.skipReason] : [];
    } else {
      e.reasons = [
        ...(stale(e) ? ['no bar for the latest candle yet — values are from an older candle'] : []),
        ...accountBlockers(e.ticker, account),
        ...e.failedRules,
      ];
    }
  }
  entries.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.ticker.localeCompare(b.ticker));

  return {
    asOf: now.toISOString(),
    scanned: tickers.length,
    candleTime,
    failed: entries.filter((e) => e.status === 'failed').map((e) => e.ticker),
    cashAvailable: account.cashAvailable,
    openCount: account.openTrades.length + account.pendingTickers.length,
    maxConcurrentOpen: S.maxConcurrentOpen,
    signals,
    entries,
    exits,
  };
}
