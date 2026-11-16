// CNN Fear & Greed daily readings for the entry filter: fetched each morning from the feed behind
// CNN's chart (the backtest's source - its history matches it exactly), or entered by hand on the
// dashboard when that fails. A signal on day D uses the latest reading from before D - the prior
// trading day's close - and none if that's over a week old, as in the backtest.
//   marketData/fearGreed   { readings: { "YYYY-MM-DD": value } }
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../admin.js';
import { lastBefore } from './daily.js';

const DOC = db.collection('marketData').doc('fearGreed');
// The backtest's own readings (~/Projects/money-maker/data/fear-greed-daily.json), so the filter
// works from the first deploy.
const SEED_FILE = join(__dirname, '..', '..', 'data', 'fear-greed-seed.json');
const MAX_AGE_DAYS = 7;

export interface FearGreedSeries {
  dates: string[];
  values: number[];
}

export async function loadFearGreed(): Promise<FearGreedSeries> {
  let readings = (await DOC.get()).get('readings') as Record<string, number> | undefined;
  if (!readings) {
    readings = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as Record<string, number>;
    await DOC.set({ readings, updatedAt: new Date() });
  }
  const dates = Object.keys(readings).sort();
  return { dates, values: dates.map((d) => readings![d]) };
}

/** The reading a signal on `day` is checked against, with its date, or undefined if none is recent. */
export function fearGreedBefore(fg: FearGreedSeries, day: string): { date: string; value: number } | undefined {
  const i = lastBefore(fg.dates, day);
  if (i < 0 || (Date.parse(day) - Date.parse(fg.dates[i])) / 86_400_000 > MAX_AGE_DAYS) return undefined;
  return { date: fg.dates[i], value: fg.values[i] };
}

export async function setFearGreedReading(date: string, value: number): Promise<void> {
  await DOC.set({ readings: { [date]: value }, updatedAt: new Date() }, { merge: true });
}

// CNN answers plain scripts with 418, so this asks the way its own page does. It may still be
// blocked from Cloud Functions or start failing any day; the dashboard entry is the fallback.
const CNN_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const CNN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://www.cnn.com/',
  Origin: 'https://www.cnn.com',
};
const DAY_MS = 86_400_000;

/**
 * Saves CNN's closing readings for the last two weeks of days before `today` that aren't stored
 * yet, leaving readings already there (entered by hand, or an earlier fetch) alone. Returns the
 * dates it added. CNN stamps each day's reading at 00:00 UTC; today's point is still moving, so
 * it's skipped.
 */
export async function fillFearGreedFromCnn(today: string): Promise<string[]> {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 14 * DAY_MS).toISOString().slice(0, 10);
  const res = await fetch(`${CNN_URL}/${from}`, { headers: CNN_HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`CNN Fear & Greed request failed ${res.status}`);
  const body = (await res.json()) as { fear_and_greed_historical?: { data?: { x: number; y: number }[] } };
  const points = body.fear_and_greed_historical?.data;
  if (!Array.isArray(points) || !points.length) throw new Error('CNN Fear & Greed response had no readings');

  const stored = (await loadFearGreed()).dates;
  const added: Record<string, number> = {};
  for (const p of points) {
    if (p.x % DAY_MS !== 0 || !(p.y >= 0 && p.y <= 100)) continue;
    const date = new Date(p.x).toISOString().slice(0, 10);
    if (date >= today || date < from || stored.includes(date)) continue;
    added[date] = Math.round(p.y * 100) / 100;
  }
  if (Object.keys(added).length) await DOC.set({ readings: added, updatedAt: new Date() }, { merge: true });
  return Object.keys(added).sort();
}
