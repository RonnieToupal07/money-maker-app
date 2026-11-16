// Firestore-backed 30-min history, in place of the backtest's local .cache files.
//   priceHistory/{TICKER}         regular-hours stock bars for completed days in the window
//   optionHistory/{OPTION_TICKER} bars for a contract a live signal selected
import { logger } from 'firebase-functions';
import { db } from '../admin.js';
import { Bar30, ChainContract, getAggs30Min } from './massive.js';

export const PRICE_HISTORY_COLLECTION = 'priceHistory';
export const OPTION_HISTORY_COLLECTION = 'optionHistory';

const BAR_MS = 30 * 60 * 1000;

const etFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
export function etParts(iso: string | Date): { date: string; minutes: number } {
  const p = Object.fromEntries(etFormat.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/** 9:30am-4:00pm ET - the only bars the strategy's indicators use. */
export function isRegularHours(bar: Bar30): boolean {
  const { minutes } = etParts(bar.time);
  return minutes >= 570 && minutes < 960;
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface PriceHistoryDoc {
  ticker: string;
  from: string;
  throughDate: string; // last completed day included; never today
  bars: Bar30[];
}

/**
 * Regular-hours bars for every completed day from `from` through yesterday. Reads
 * priceHistory/{ticker} and only asks the API for the days after the doc's throughDate, so after
 * the first scan of the day each ticker costs one Firestore read and no history API call.
 */
export async function loadPriceHistory(ticker: string, from: string, today: string): Promise<Bar30[]> {
  const ref = db.collection(PRICE_HISTORY_COLLECTION).doc(ticker);
  const stored = (await ref.get()).data() as PriceHistoryDoc | undefined;
  const yesterday = addDays(today, -1);
  let bars = stored?.bars ?? [];

  if (!stored || stored.throughDate < yesterday || stored.from > from) {
    const fetchFrom = stored && stored.from <= from && stored.throughDate >= from ? addDays(stored.throughDate, 1) : from;
    const fresh = (await getAggs30Min(ticker, fetchFrom, yesterday)).filter(isRegularHours);
    bars = [...bars.filter((b) => etParts(b.time).date < fetchFrom), ...fresh];
    bars = bars.filter((b) => etParts(b.time).date >= from);
    await ref.set({ ticker, from, throughDate: yesterday, bars, updatedAt: new Date() });
  }
  return bars.filter((b) => etParts(b.time).date >= from);
}

/** Saves the contract's completed 30-min bars from `from` through now to optionHistory. */
export async function saveOptionHistory(underlying: string, contract: ChainContract, from: string, today: string) {
  try {
    const nowMs = Date.now();
    const bars = (await getAggs30Min(contract.ticker, from, today)).filter(
      (b) => new Date(b.time).getTime() + BAR_MS <= nowMs,
    );
    await db.collection(OPTION_HISTORY_COLLECTION).doc(contract.ticker).set({
      contractTicker: contract.ticker,
      underlying,
      strike: contract.strikePrice,
      expiration: contract.expirationDate,
      from,
      bars,
      updatedAt: new Date(),
    });
  } catch (err) {
    logger.warn(`${contract.ticker}: failed to save option history`, { error: (err as Error).message });
  }
}
