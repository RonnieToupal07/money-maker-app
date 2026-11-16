// The Bx-Trender seller's entry score: an entry's indicator readings, ported from the scripts that
// built the backtest's candidates-readings.csv in ~/Projects/money-maker/src (addBxEntryColumns.ts,
// _tmp_macdIndicators.ts, addBxMarketCap.ts, addBxBetaAlpha.ts), and the points tables they're
// scored against (inEntryGroup and entryGroupScore in backtest.ts). Readings are kept as the text
// those scripts wrote, rounded the same way, so a reading at a group's edge lands in the same group.
// Today's bar stands in for the backtest's entry-day bar: its close is the latest price and its
// volume, high and low are the session's so far.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BX, BxDirection } from './bxConfig.js';
import { dailyContext, realizedVol20, rollingVwapSigma, stochK52, trendBefore } from './daily.js';
import { ema, rsi, sma } from './indicators.js';
import { IvSeries, ivBefore, ivRankBefore } from './ivSeries.js';
import { DailyBar } from './massive.js';

export interface EntryGroup {
  indicator: string;
  label: string;
  min?: number;
  max?: number;
  equals?: string;
  missing?: true;
  points?: number;
}

const DATA_DIR = join(__dirname, '..', '..', 'data');
const tables = new Map<string, EntryGroup[]>();
function groups(file: string): EntryGroup[] {
  let g = tables.get(file);
  if (!g) {
    g = (JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8')) as { groups: EntryGroup[] }).groups;
    tables.set(file, g);
  }
  return g;
}

export type Readings = Record<string, string>;

/** Whether the readings fall in group g - backtest.ts's inEntryGroup. */
function inGroup(g: EntryGroup, r: Readings): boolean {
  const raw = g.indicator === 'premiumPctOfStock' ? String((100 * Number(r['entryOption'])) / Number(r['entryStock'])) : r[g.indicator] ?? '';
  if (g.missing) return raw === '';
  if (raw === '') return false;
  if (g.equals !== undefined) return raw === g.equals;
  const v = Number(raw);
  return (g.min === undefined || v >= g.min) && (g.max === undefined || v < g.max);
}

/** The sum of the points of every group of the side's table the readings fall in. */
export function entryScore(direction: BxDirection, r: Readings): number {
  return groups(direction === 'sell_put' ? BX.putPointsFile : BX.callPointsFile).reduce((sum, g) => sum + (inGroup(g, r) ? g.points ?? 0 : 0), 0);
}

const NAMES: Record<string, string> = {
  premiumPctOfStock: 'Premium % of stock', entryRsi90: '90-day RSI', entryRsi14: '14-day RSI', ivMinusHv: 'IV minus HV',
  macdSlopeDaily: 'MACD slope', macdDaily: 'MACD', marketCapSpy: 'Market cap', entryIv: 'IV', rsiSmoothedDaily: 'Smoothed RSI',
  bbPctB: 'Bollinger %B', alpha21: 'Monthly alpha', beta252: 'Beta', fearGreed: 'Fear & Greed', relSpy90: '90-day vs SPY',
  relSpy20: '20-day vs SPY', ivRankMacd: 'IV rank', stochK52: '52-week %K', adx14: 'ADX', rvol: 'RVOL', vwap20Sigma: '20-day VWAP σ',
  trend50200: '50/200-day trend', spyRegime: 'SPY regime',
};

/** The first of the side's skip groups the readings fall in, as text, or null. */
export function skipGroup(direction: BxDirection, r: Readings): string | null {
  const g = groups(direction === 'sell_put' ? BX.putAvoidFile : BX.callAvoidFile).find((x) => inGroup(x, r));
  return g ? `${NAMES[g.indicator] ?? g.indicator} ${g.label}` : null;
}

/** Share of the account value a trade with this score is sized to. */
export function sizingPct(direction: BxDirection, score: number): number {
  const s = BX.sizing;
  const [lo, hi] = direction === 'sell_call' ? s.call : s.put;
  const f = Math.min(1, Math.max(0, (score - lo) / (hi - lo))) ** s.power;
  return s.minPct + (s.maxPct - s.minPct) * f;
}

export interface ReadingsInput {
  day: string;
  /** The stock's split-adjusted daily bars, today's (so far) last. */
  bars: DailyBar[];
  /** SPY's, the same way. */
  spyBars: DailyBar[];
  /** The stock's daily IV readings; the ones before `day` are used. */
  iv: IvSeries | undefined;
  /** The stock's IV today (decimal), the backtest's entryIv. */
  ivToday: number | undefined;
  /** The last Fear & Greed reading before `day`, within a week. */
  fearGreed: number | undefined;
  /** Split-adjusted shares outstanding. */
  sharesOutstanding: number | undefined;
  /** The option's price, before the backtest's fill slippage. */
  optionPrice: number;
}

const f = (v: number | undefined, d: number) => (v === undefined || !Number.isFinite(v) ? '' : v.toFixed(d));

/** Bollinger %B at bar k: 0 at the lower band, 100 at the upper (20-day, 2 population sd). */
function bbPctB(closes: number[], k: number): number | undefined {
  if (k < 19) return undefined;
  const w = closes.slice(k - 19, k + 1), mean = w.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
  return sd > 0 ? ((closes[k] - (mean - 2 * sd)) / (4 * sd)) * 100 : undefined;
}

/** Beta of the stock's daily returns on SPY's over the 252 days through k, and the 21-day alpha in percent. */
function betaAlpha(bars: DailyBar[], k: number, spy: Map<string, number>): [number, number] | undefined {
  if (k < 252) return undefined;
  const xs: number[] = [], ys: number[] = [];
  for (let i = k - 251; i <= k; i++) {
    const s0 = spy.get(bars[i - 1].date), s1 = spy.get(bars[i].date);
    if (s0 === undefined || s1 === undefined) continue;
    xs.push(s1 / s0 - 1);
    ys.push(bars[i].close / bars[i - 1].close - 1);
  }
  if (xs.length < 252 * 0.9) return undefined;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0, vx = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; }
  const beta = cov / vx;
  const sNow = spy.get(bars[k].date), sThen = spy.get(bars[k - 21].date);
  if (sNow === undefined || sThen === undefined) return undefined;
  return [beta, ((bars[k].close / bars[k - 21].close - 1) - beta * (sNow / sThen - 1)) * 100];
}

/** Every reading the points tables score, as the backtest's readings file has them. */
export function entryReadings(x: ReadingsInput): Readings {
  const { bars, spyBars, day } = x;
  const k = bars.length - 1, si = spyBars.length - 1;
  if (k < 0 || bars[k].date !== day || si < 0 || spyBars[si].date !== day) throw new Error(`readings need ${day}'s bar last`);
  const closes = bars.map((b) => b.close), spyCloses = spyBars.map((b) => b.close);
  const price = closes[k];
  const r: Readings = {};

  r['entryStock'] = price.toFixed(2);
  r['entryOption'] = Math.max(x.optionPrice * (1 - BX.fillSlippagePct), 0.01).toFixed(2);
  r['entryIv'] = x.ivToday === undefined ? '' : (x.ivToday * 100).toFixed(1);

  // addBxEntryColumns.ts
  const spyEma50 = ema(spyCloses, 50), spyEma200 = ema(spyCloses, 200);
  if (!Number.isNaN(spyEma200[si])) {
    const a50 = spyCloses[si] > spyEma50[si], a200 = spyCloses[si] > spyEma200[si];
    r['spyRegime'] = a50 && a200 ? 'above_both' : a50 ? 'above_50' : a200 ? 'above_200' : 'below_both';
  } else r['spyRegime'] = '';
  r['entryRsi14'] = f(rsi(closes, 14)[k], 1);
  r['entryRsi90'] = f(rsi(closes, 90)[k], 1);
  r['relSpy90'] = k >= 90 && si >= 90 ? f(((closes[k] / closes[k - 90] - 1) - (spyCloses[si] / spyCloses[si - 90] - 1)) * 100, 2) : '';
  r['bbPctB'] = f(bbPctB(closes, k), 1);

  // _tmp_macdIndicators.ts: daily readings from the bars before today, priced at today's close.
  const history = dailyContext(bars.slice(0, k));
  const j = k - 1;
  r['fearGreed'] = f(x.fearGreed, 0);
  r['vwap20Sigma'] = f(rollingVwapSigma(history, day, price, 20), 3);
  r['adx14'] = f(j >= 0 ? history.adx[j] ?? undefined : undefined, 3);
  r['ivRankMacd'] = f(ivRankBefore(x.iv, day), 3);
  const ivPrior = ivBefore(x.iv, day), hv = realizedVol20(history, day);
  r['ivMinusHv'] = f(ivPrior !== undefined && hv !== undefined ? ivPrior * 100 - hv * 100 : undefined, 3);
  r['stochK52'] = f(stochK52(history, day, price, bars[k].high, bars[k].low), 3);
  r['trend50200'] = trendBefore(history, day, price) ?? '';
  r['relSpy20'] = j >= 19 && si >= 20 ? f(((price / closes[j - 19] - 1) - (spyCloses[si] / spyCloses[si - 20] - 1)) * 100, 3) : '';
  let volSum = 0;
  if (k >= 20) for (let q = k - 20; q < k; q++) volSum += bars[q].volume;
  r['rvol'] = f(k >= 20 && volSum > 0 ? bars[k].volume / (volSum / 20) : undefined, 3);
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macd = (i: number) => e12[i] - e26[i];
  const macdOk = k >= 1 && Number.isFinite(macd(k)) && Number.isFinite(macd(k - 1));
  r['macdDaily'] = macdOk ? f(macd(k), 3) : '';
  r['macdSlopeDaily'] = macdOk ? f(macd(k) - macd(k - 1), 3) : '';
  r['rsiSmoothedDaily'] = f(sma(rsi(closes, 14), 5)[k], 3);

  // addBxMarketCap.ts: grown by SPY to the backtest's last day.
  const cap = x.sharesOutstanding !== undefined ? x.sharesOutstanding * price : undefined;
  r['marketCapSpy'] = cap === undefined ? '' : String(Math.round(cap * (BX.spyCloseAtPointsDate / spyCloses[si])));

  // addBxBetaAlpha.ts
  const ba = betaAlpha(bars, k, new Map(spyBars.map((b) => [b.date, b.close])));
  r['beta252'] = ba ? ba[0].toFixed(2) : '';
  r['alpha21'] = ba ? ba[1].toFixed(2) : '';
  return r;
}
