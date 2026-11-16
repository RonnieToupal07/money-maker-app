// The Bx-Trender put/call seller's decisions, ported from ~/Projects/money-maker/src: bxTrender.ts,
// bxTrenderCalc.ts, optionSelection.ts, blackScholes.ts and backtest.ts (regTBuyingPower,
// manageTrade, the sizing loop). No I/O here, so every rule can be checked against the backtest.
// The entry score is in bxEntryScore.ts.
import { BX, BxDirection, SpyRegime } from './bxConfig.js';
import { ema, rsi } from './indicators.js';

// ---- Signal ----

/** shortTermXtrender = rsi(ema(close, 5) - ema(close, 20), 5) - 50, on split-adjusted closes. */
export function bxScores(adjustedCloses: number[]): number[] {
  const { shortL1, shortL2, shortL3 } = BX.bxParams;
  const fast = ema(adjustedCloses, shortL1);
  const slow = ema(adjustedCloses, shortL2);
  return rsi(fast.map((x, i) => x - slow[i]), shortL3).map((x) => x - 50);
}

/** A signal on the last score: it turned back after peaking or troughing inside the band. */
export function detectSignal(scores: number[]): { direction: BxDirection; peakScore: number } | null {
  const n = scores.length;
  if (n < 3) return null;
  const p = scores[n - 1], prev = scores[n - 2], prev2 = scores[n - 3];
  if ([p, prev, prev2].some(Number.isNaN)) return null;
  if (prev > prev2 && p < prev && prev >= BX.callBandMin && prev <= BX.callBandMax) return { direction: 'sell_call', peakScore: prev };
  if (prev < prev2 && p > prev && prev <= -BX.putBandMin && prev >= -BX.putBandMax) return { direction: 'sell_put', peakScore: prev };
  return null;
}

export function spyRegimeOf(adjustedCloses: number[]): SpyRegime | undefined {
  const fast = ema(adjustedCloses, BX.spyFastEmaDays), slow = ema(adjustedCloses, BX.spySlowEmaDays);
  const i = adjustedCloses.length - 1;
  if (i < 0 || Number.isNaN(fast[i]) || Number.isNaN(slow[i])) return undefined;
  const aboveFast = adjustedCloses[i] > fast[i], aboveSlow = adjustedCloses[i] > slow[i];
  return aboveFast && aboveSlow ? 'aboveBoth' : aboveFast ? 'above50Only' : aboveSlow ? 'above200Only' : 'belowBoth';
}

// ---- Black-Scholes and contract choice ----

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) prob = 1 - prob;
  return prob;
}

interface BsInput {
  spot: number;
  strike: number;
  years: number;
  isPut: boolean;
}

function d1d2({ spot, strike, years }: BsInput, vol: number): [number, number] {
  const d1 = (Math.log(spot / strike) + (BX.riskFreeRate - BX.dividendYield + 0.5 * vol * vol) * years) / (vol * Math.sqrt(years));
  return [d1, d1 - vol * Math.sqrt(years)];
}

function bsPrice(p: BsInput, vol: number): number {
  const [d1, d2] = d1d2(p, vol);
  const s = p.spot * Math.exp(-BX.dividendYield * p.years), k = p.strike * Math.exp(-BX.riskFreeRate * p.years);
  return p.isPut ? k * normCdf(-d2) - s * normCdf(-d1) : s * normCdf(d1) - k * normCdf(d2);
}

export function bsDelta(p: BsInput, vol: number): number {
  const [d1] = d1d2(p, vol);
  const adj = Math.exp(-BX.dividendYield * p.years);
  return p.isPut ? adj * (normCdf(d1) - 1) : adj * normCdf(d1);
}

export function impliedVol(price: number, p: BsInput): number | undefined {
  if (price <= 0) return undefined;
  let lo = 0.001, hi = 5;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const value = bsPrice(p, mid);
    if (Math.abs(value - price) < 1e-4) return mid;
    if (value > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const yearsBetween = (from: string, to: string) => Math.max((Date.parse(to) - Date.parse(from)) / (365 * 86_400_000), 1 / 365);

/** Annualized realized volatility of these closes, the delta fallback when IV can't be solved. */
export function realizedVolatility(closes: number[]): number {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length) * Math.sqrt(252);
}

export interface BxContract {
  ticker: string; // O:TSLA261127P00300000
  strikePrice: number;
  expirationDate: string;
  close: number | null;
  volume: number;
  bid: number | null;
  ask: number | null;
}

export interface PickedContract {
  contract: BxContract;
  price: number;
  delta: number;
  dte: number;
}

/** Highest premium within the delta tolerance, else the delta nearest the target. */
export function pickContract(direction: BxDirection, day: string, spot: number, approxIv: number, contracts: BxContract[]): PickedContract | undefined {
  const isPut = direction === 'sell_put';
  const priced: PickedContract[] = [];
  for (const c of contracts) {
    const dte = daysBetween(day, c.expirationDate);
    const otm = isPut ? (spot - c.strikePrice) / spot : (c.strikePrice - spot) / spot;
    if (dte < BX.minDte || dte > BX.maxDte || otm < 0 || otm > BX.maxOtmPct) continue;
    if (c.close == null || c.close <= 0) continue;
    const input = { spot, strike: c.strikePrice, years: yearsBetween(day, c.expirationDate), isPut };
    priced.push({ contract: c, price: c.close, dte, delta: bsDelta(input, impliedVol(c.close, input) ?? approxIv) });
  }
  if (!priced.length) return undefined;
  const target = isPut ? BX.putTargetDelta : BX.callTargetDelta;
  const diff = (p: PickedContract) => Math.abs(Math.abs(p.delta) - target);
  const within = priced.filter((p) => diff(p) <= BX.deltaTolerance);
  return within.length ? within.reduce((a, b) => (b.price > a.price ? b : a)) : priced.reduce((a, b) => (diff(b) < diff(a) ? b : a));
}

// ---- Margin and sizing ----

/** House margin percentage at this IV; 0 when IV is unknown or under every tier. */
export function houseMarginPct(iv: number | undefined): number {
  if (iv === undefined) return 0;
  return BX.volatilityMarginTiers.find((t) => iv >= t.minIv)?.pct ?? 0;
}

/** Margin for one naked contract: the larger of the price-based and strike-based requirements. */
export function perContractBuyingPower(direction: BxDirection, spot: number, strike: number, premium: number, housePct = 0): number {
  const otm = direction === 'sell_put' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  return Math.max(Math.max(0.2, housePct) * spot - otm + premium, Math.max(0.3, housePct) * strike) * 100;
}

export interface SizeInput {
  accountValue: number;
  /** Margin room left: account value less what open trades and earlier picks tie up. */
  remaining: number;
  /** sizingPct for the entry's score. */
  pct: number;
  perContractBp: number;
  volume: number;
}

/** Contracts for one entry: at least 1 if it fits at all, 0 if even 1 doesn't. */
export function contractsFor(s: SizeInput): number {
  if (s.perContractBp > s.remaining || Math.floor(s.volume) < 1) return 0;
  const fromPct = Math.min(BX.sizing.maxContracts, Math.floor((s.pct * s.accountValue) / s.perContractBp));
  return Math.max(1, Math.min(fromPct, Math.floor(s.remaining / s.perContractBp), Math.floor(s.volume)));
}

// ---- Exits ----

export type BxExitReason = 'take_profit' | 'stop_loss' | 'dte_exit' | 'expiration_risk';

export interface ExitInput {
  direction: BxDirection;
  entryPrice: number;
  /** The option's price right now. */
  mark: number;
  dte: number;
  bxScore: number | undefined;
  iv: number | undefined;
  stopDelayDaysUsed: number;
}

/** The take-profit level (share of the premium kept) at this many days left. */
export function takeProfitPct(direction: BxDirection, dte: number): number {
  const isPut = direction === 'sell_put';
  const row = (isPut ? BX.putTakeProfitByDte : BX.callTakeProfitByDte).find((r) => dte >= r.minDte && dte <= r.maxDte);
  return row?.pct ?? (isPut ? BX.putTakeProfitPct : BX.callTakeProfitPct);
}

/** One day's exit check, in manageTrade's order. Returns the delay count to carry to tomorrow. */
export function checkExit(x: ExitInput): { reason: BxExitReason | null; stopDelayDaysUsed: number; note: string } {
  const isPut = x.direction === 'sell_put';
  if (x.dte <= BX.expirationWarningDte) return { reason: 'expiration_risk', stopDelayDaysUsed: x.stopDelayDaysUsed, note: `${x.dte} days to expiration, assignment risk` };
  const holdAbs = isPut ? BX.putNeverExitBxAbs : BX.callNeverExitBxAbs;
  if (x.bxScore !== undefined && Math.abs(x.bxScore) > holdAbs) {
    return { reason: null, stopDelayDaysUsed: x.stopDelayDaysUsed, note: `held: Bx ${x.bxScore.toFixed(1)} beyond ±${holdAbs}` };
  }
  const profit = (x.entryPrice - x.mark) / x.entryPrice, loss = -profit;
  const target = takeProfitPct(x.direction, x.dte);
  if (profit >= target) {
    return { reason: 'take_profit', stopDelayDaysUsed: x.stopDelayDaysUsed, note: `up ${(profit * 100).toFixed(1)}% of premium (target ${Math.round(target * 100)}% at ${x.dte} days left)` };
  }
  let delay = x.stopDelayDaysUsed, note = 'no exit rule met';
  if (loss >= (isPut ? BX.putStopLossPct : BX.callStopLossPct)) {
    if (x.iv !== undefined && x.iv >= BX.stopLossNeverExitIv) note = `stop blocked: IV ${(x.iv * 100).toFixed(0)}%`;
    else if (x.iv !== undefined && x.iv >= BX.stopLossIvDelayThreshold && delay < BX.stopLossIvDelayMaxDays) {
      delay++;
      note = `stop delayed a day: IV ${(x.iv * 100).toFixed(0)}%`;
    } else return { reason: 'stop_loss', stopDelayDaysUsed: delay, note: `down ${(loss * 100).toFixed(0)}% of premium` };
  } else delay = 0;
  if (x.dte <= (isPut ? BX.putExitAtDte : BX.callExitAtDte)) return { reason: 'dte_exit', stopDelayDaysUsed: delay, note: `${x.dte} days to expiration` };
  return { reason: null, stopDelayDaysUsed: delay, note };
}
