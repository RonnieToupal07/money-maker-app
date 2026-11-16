// Firestore-backed daily bars and the daily-bar indicators the entry filters use, ported from
// rollingVwapSigma / wilderAdx / stochK52 / trendBefore / boostReadings in
// ~/Projects/money-maker/src/macdexpCandleBacktest.ts. Everything is read from the daily bars
// strictly before the signal day, plus the signal day's session through the signal candle.
//   dailyHistory/{TICKER}   split-adjusted daily bars for completed days, refreshed once a day
import { db } from '../admin.js';
import { addDays } from './history.js';
import { DailyBar, getAggsDaily } from './massive.js';

export const DAILY_HISTORY_COLLECTION = 'dailyHistory';
// ~350 trading days: 252 for the 52-week range, 200 for the long average, and room for ADX to settle.
const DAILY_DAYS = 520;

interface DailyHistoryDoc {
  ticker: string;
  throughDate: string; // last completed day included; never today
  bars: DailyBar[];
}

/**
 * Split-adjusted daily bars through yesterday. The whole window is re-fetched once a day (one
 * request per ticker), so a split never leaves old bars on the wrong basis.
 */
export async function loadDailyHistory(ticker: string, today: string): Promise<DailyBar[]> {
  const ref = db.collection(DAILY_HISTORY_COLLECTION).doc(ticker);
  const stored = (await ref.get()).data() as DailyHistoryDoc | undefined;
  const yesterday = addDays(today, -1);
  if (stored && stored.throughDate >= yesterday) return stored.bars.filter((b) => b.date < today);
  const bars = (await getAggsDaily(ticker, addDays(today, -DAILY_DAYS), yesterday)).filter((b) => b.date < today);
  await ref.set({ ticker, throughDate: yesterday, bars, updatedAt: new Date() });
  return bars;
}

/** Index of the last bar strictly before `day`, or -1. */
export function lastBefore(dates: string[], day: string): number {
  let lo = 0, hi = dates.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < day) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

/** Wilder ADX(len), null during warm-up - same as the backtest's wilderAdx. */
export function wilderAdx(bars: { high: number; low: number; close: number }[], len: number): (number | null)[] {
  const out: (number | null)[] = bars.map(() => null);
  let tr = 0, pdm = 0, mdm = 0, adx: number | null = null;
  const dxs: number[] = [];
  for (let q = 1; q < bars.length; q++) {
    const h = bars[q].high, l = bars[q].low, pc = bars[q - 1].close;
    const t = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = h - bars[q - 1].high, dn = bars[q - 1].low - l;
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    if (q <= len) { tr += t; pdm += p; mdm += m; if (q < len) continue; }
    else { tr = tr - tr / len + t; pdm = pdm - pdm / len + p; mdm = mdm - mdm / len + m; }
    const pdi = tr > 0 ? (100 * pdm) / tr : 0, mdi = tr > 0 ? (100 * mdm) / tr : 0;
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    if (adx === null) { dxs.push(dx); if (dxs.length === len) { adx = dxs.reduce((a, b) => a + b, 0) / len; out[q] = adx; } }
    else { adx = (adx * (len - 1) + dx) / len; out[q] = adx; }
  }
  return out;
}

export type Trend = 'aboveBoth' | 'above200Only' | 'above50Only' | 'belowBoth';

/** One ticker's daily bars with the per-bar series the filters read. */
export interface DailyContext {
  dates: string[];
  bars: DailyBar[];
  adx: (number | null)[];
}

export function dailyContext(bars: DailyBar[]): DailyContext {
  return { dates: bars.map((b) => b.date), bars, adx: wilderAdx(bars, 14) };
}

/** Sigma of `price` from the VWAP of the `days` daily bars before `day` (typical price, volume-weighted). */
export function rollingVwapSigma(d: DailyContext, day: string, price: number, days: number): number | undefined {
  const j = lastBefore(d.dates, day);
  if (j < days - 1) return undefined;
  let v = 0, pv = 0, p2v = 0;
  for (let q = j - days + 1; q <= j; q++) {
    const b = d.bars[q], tp = (b.high + b.low + b.close) / 3;
    v += b.volume; pv += tp * b.volume; p2v += tp * tp * b.volume;
  }
  if (v <= 0) return undefined;
  const vwap = pv / v, sd = Math.sqrt(Math.max(0, p2v / v - vwap * vwap));
  return sd > 1e-9 ? (price - vwap) / sd : undefined;
}

/** Daily ADX(14) on the last trading day before `day`. */
export function adxBefore(d: DailyContext, day: string): number | undefined {
  const j = lastBefore(d.dates, day);
  return j >= 0 ? d.adx[j] ?? undefined : undefined;
}

/** 52-week %K: `price` within the range of the 252 daily bars before `day` and today's session so far. */
export function stochK52(d: DailyContext, day: string, price: number, sessionHigh: number, sessionLow: number): number | undefined {
  const j = lastBefore(d.dates, day);
  if (j < 251) return undefined;
  let hh = sessionHigh, ll = sessionLow;
  for (let q = j - 251; q <= j; q++) { hh = Math.max(hh, d.bars[q].high); ll = Math.min(ll, d.bars[q].low); }
  return hh > ll ? ((price - ll) / (hh - ll)) * 100 : undefined;
}

/** `price` against the 50- and 200-day averages of the daily closes before `day`. */
export function trendBefore(d: DailyContext, day: string, price: number): Trend | undefined {
  const j = lastBefore(d.dates, day);
  if (j < 199) return undefined;
  let s50 = 0, s200 = 0;
  for (let q = j - 199; q <= j; q++) { s200 += d.bars[q].close; if (q > j - 50) s50 += d.bars[q].close; }
  const a200 = price > s200 / 200, a50 = price > s50 / 50;
  return a200 && a50 ? 'aboveBoth' : a200 ? 'above200Only' : a50 ? 'above50Only' : 'belowBoth';
}

/** Annualized 20-day realized vol (stdev of daily log returns) from the bars before `day`. */
export function realizedVol20(d: DailyContext, day: string): number | undefined {
  const j = lastBefore(d.dates, day);
  if (j < 20) return undefined;
  const r: number[] = [];
  for (let q = j - 19; q <= j; q++) r.push(Math.log(d.bars[q].close / d.bars[q - 1].close));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
  return sd * Math.sqrt(252);
}

/** Percent return from the close 20 trading days before `day` (bar j-19) to `price`. */
export function return20(d: DailyContext, day: string, price: number): number | undefined {
  const j = lastBefore(d.dates, day);
  return j >= 19 ? price / d.bars[j - 19].close - 1 : undefined;
}
