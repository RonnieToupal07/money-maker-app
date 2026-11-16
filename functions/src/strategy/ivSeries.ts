// Daily implied vol per ticker for the IV-rank filter and the IV-minus-realized-vol boost rule,
// built the way ~/Projects/money-maker's ivRankAll.ts built the backtest's data/iv-series: each
// trading day's IV is backed out (Black-Scholes) from the daily close of the call nearest the money
// at the Friday expiration nearest 30 days out, trying the next-nearest strikes when one didn't trade.
//   ivSeries/{TICKER}   { vals: { "YYYY-MM-DD": iv } }, the last KEEP readings
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from 'firebase-functions';
import { db } from '../admin.js';
import { MACDEXP } from './config.js';
import { addDays, etParts } from './history.js';
import { lastBefore } from './daily.js';
import { getAggsDaily, getCallContractsAsOf } from './massive.js';

export const IV_SERIES_COLLECTION = 'ivSeries';
const KEEP = 300;
const LOOKBACK = 252;
const MIN_OBS = 60;
const MAX_AGE_DAYS = 7;
const STRIKES_TO_TRY = 5;
const TARGET_DTE = 30;
// The backtest's series, trimmed to the last KEEP readings per ticker, seed each ticker's doc.
const SEED_FILE = join(__dirname, '..', '..', 'data', 'iv-seed.json');

export interface IvSeries {
  dates: string[];
  vals: number[];
}

let seed: Record<string, Record<string, number>> | undefined;
function seedFor(ticker: string): Record<string, number> | undefined {
  seed ??= JSON.parse(readFileSync(SEED_FILE, 'utf8')) as Record<string, Record<string, number>>;
  return seed[ticker];
}

function toSeries(vals: Record<string, number>): IvSeries {
  const dates = Object.keys(vals).sort();
  return { dates, vals: dates.map((d) => vals[d]) };
}

export async function loadIvSeries(ticker: string): Promise<IvSeries | undefined> {
  const ref = db.collection(IV_SERIES_COLLECTION).doc(ticker);
  let vals = (await ref.get()).get('vals') as Record<string, number> | undefined;
  if (!vals) {
    vals = seedFor(ticker);
    if (!vals) return undefined;
    await ref.set({ vals, updatedAt: new Date() });
  }
  return toSeries(vals);
}

/** Raw IV (decimal) from the last reading before `day`, within a week. */
export function ivBefore(s: IvSeries | undefined, day: string): number | undefined {
  if (!s) return undefined;
  const i = lastBefore(s.dates, day);
  if (i < 0 || (Date.parse(day) - Date.parse(s.dates[i])) / 86_400_000 > MAX_AGE_DAYS) return undefined;
  return s.vals[i];
}

/** IV rank (0-100) as of the last reading before `day`, against the 252 readings ending there. */
export function ivRankBefore(s: IvSeries | undefined, day: string): number | undefined {
  if (!s) return undefined;
  const i = lastBefore(s.dates, day);
  if (i < 0 || (Date.parse(day) - Date.parse(s.dates[i])) / 86_400_000 > MAX_AGE_DAYS) return undefined;
  const w = s.vals.slice(Math.max(0, i - LOOKBACK + 1), i + 1);
  if (w.length < MIN_OBS) return undefined;
  const mn = Math.min(...w), mx = Math.max(...w);
  return mx > mn ? ((s.vals[i] - mn) / (mx - mn)) * 100 : undefined;
}

// ---- Black-Scholes, from ~/Projects/money-maker/src/blackScholes.ts ----

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) prob = 1 - prob;
  return prob;
}

function callPrice(spot: number, strike: number, t: number, r: number, q: number, v: number): number {
  const d1 = (Math.log(spot / strike) + (r - q + 0.5 * v * v) * t) / (v * Math.sqrt(t));
  const d2 = d1 - v * Math.sqrt(t);
  return spot * Math.exp(-q * t) * normCdf(d1) - strike * Math.exp(-r * t) * normCdf(d2);
}

/** Bisection for the volatility that reproduces `price`. */
function impliedVol(price: number, spot: number, strike: number, t: number): number | undefined {
  if (price <= 0) return undefined;
  let lo = 0.001, hi = 5;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const p = callPrice(spot, strike, t, MACDEXP.riskFreeRate, MACDEXP.dividendYield, mid);
    if (Math.abs(p - price) < 1e-4) return mid;
    if (p > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

const yearsBetween = (from: string, to: string) => Math.max((Date.parse(to) - Date.parse(from)) / (365 * 86_400_000), 1 / 365);
const dteOf = (d: string, exp: string) => Math.round((Date.parse(exp) - Date.parse(d)) / 86_400_000);

/** One day's IV from its actual (unadjusted) stock close, or undefined if no nearby call traded. */
async function ivOn(ticker: string, date: string, stockClose: number): Promise<number | undefined> {
  // Fridays 21-42 days out, nearest to 30 first; the first with listed calls is used.
  const fridays: string[] = [];
  for (let k = 21; k <= 42; k++) {
    const d = addDays(date, k);
    if (new Date(d + 'T12:00:00Z').getUTCDay() === 5) fridays.push(d);
  }
  fridays.sort((a, b) => Math.abs(dteOf(date, a) - TARGET_DTE) - Math.abs(dteOf(date, b) - TARGET_DTE));
  for (const exp of fridays) {
    const calls = await getCallContractsAsOf(ticker, exp, date);
    if (!calls.length) continue;
    const near = [...calls].sort((a, b) => Math.abs(a.strikePrice - stockClose) - Math.abs(b.strikePrice - stockClose)).slice(0, STRIKES_TO_TRY);
    for (const c of near) {
      const px = (await getAggsDaily(c.ticker, date, date))[0]?.close;
      if (!px || px <= 0) continue;
      const v = impliedVol(px, stockClose, c.strikePrice, yearsBetween(date, c.expirationDate));
      if (v !== undefined) return v;
    }
    return undefined; // only the nearest-to-30-DTE expiration that has listed calls
  }
  return undefined;
}

/**
 * Today's IV so far, the way the nightly update will read it after the close: from the latest
 * price of the stock and of the call nearest the money. Undefined if none of those calls traded.
 */
export const ivSoFar = (ticker: string, today: string, stockPrice: number) => ivOn(ticker, today, stockPrice);

/**
 * Adds every trading day from the series' last reading through `today` (after the close) for one
 * ticker, at most the last two weeks. Returns how many readings were added.
 */
export async function updateIvSeries(ticker: string, today: string): Promise<number> {
  const s = await loadIvSeries(ticker);
  const vals: Record<string, number> = {};
  s?.dates.forEach((d, i) => (vals[d] = s.vals[i]));
  const last = s?.dates[s.dates.length - 1];
  const from = last && last > addDays(today, -14) ? addDays(last, 1) : addDays(today, -14);
  if (from > today) return 0;
  const days = (await getAggsDaily(ticker, from, today, false)).filter((b) => b.date >= from && b.date <= today);
  let added = 0;
  for (const bar of days) {
    try {
      const v = await ivOn(ticker, bar.date, bar.close);
      if (v !== undefined) { vals[bar.date] = v; added++; }
    } catch (err) {
      logger.warn(`${ticker}: IV for ${bar.date} failed`, { error: (err as Error).message });
    }
  }
  if (added) {
    const kept = Object.keys(vals).sort().slice(-KEEP);
    await db.collection(IV_SERIES_COLLECTION).doc(ticker).set({
      vals: Object.fromEntries(kept.map((d) => [d, vals[d]])),
      updatedAt: new Date(),
    });
  }
  return added;
}

/** Today's ET date, for the nightly job. */
export const etToday = () => etParts(new Date()).date;
