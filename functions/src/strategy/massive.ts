// Live-data subset of ~/Projects/money-maker/src/massiveClient.ts. Nothing here is cached.
import { logger } from 'firebase-functions';

const BASE_URL = 'https://api.massive.com';
const FETCH_TIMEOUT_MS = 30000;

export interface Bar30 {
  time: string; // ISO timestamp of the bar's open
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function withKey(url: string): string {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) throw new Error('MASSIVE_API_KEY is not set in functions/.env');
  const u = new URL(url);
  if (!u.searchParams.has('apiKey')) u.searchParams.set('apiKey', key);
  return u.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string, attempt = 1): Promise<T> {
  let res: Response;
  try {
    res = await fetch(withKey(url), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (attempt <= 3) {
      logger.warn(`[massive] network error on attempt ${attempt} (${(err as Error).message}), retrying`, { url });
      await sleep(1000 * attempt);
      return getJson<T>(url, attempt + 1);
    }
    throw err;
  }
  if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
    await sleep(1000 * attempt);
    return getJson<T>(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`Massive API error ${res.status} for ${url}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface AggsResponse {
  results?: Array<{ o: number; h: number; l: number; c: number; v: number; t: number }>;
  next_url?: string;
}

/** Split-adjusted minute bars (5, 30, ...) across the whole range, paged to completion. */
export async function getAggsMinutes(ticker: string, minutes: number, from: string, to: string): Promise<Bar30[]> {
  const bars: Bar30[] = [];
  let url: string | undefined =
    `${BASE_URL}/v2/aggs/ticker/${ticker}/range/${minutes}/minute/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
  while (url) {
    const page: AggsResponse = await getJson<AggsResponse>(url);
    for (const r of page.results ?? []) {
      bars.push({ time: new Date(r.t).toISOString(), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v });
    }
    url = page.next_url;
  }
  return bars;
}

/** Split-adjusted 30-minute bars across the whole range, paged to completion. */
export const getAggs30Min = (ticker: string, from: string, to: string) => getAggsMinutes(ticker, 30, from, to);

export interface DailyBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Daily bars, split-adjusted (indicators) or not (actual prices, to compare with strikes). */
export async function getAggsDaily(ticker: string, from: string, to: string, adjusted = true): Promise<DailyBar[]> {
  const bars: DailyBar[] = [];
  let url: string | undefined =
    `${BASE_URL}/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=${adjusted}&sort=asc&limit=50000`;
  while (url) {
    const page: AggsResponse = await getJson<AggsResponse>(url);
    for (const r of page.results ?? []) {
      bars.push({ date: new Date(r.t).toISOString().slice(0, 10), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v });
    }
    url = page.next_url;
  }
  return bars;
}

interface ContractsResponse {
  results?: Array<{ ticker: string; strike_price: number; expiration_date: string }>;
  next_url?: string;
}

/** Call contracts listed for one expiration as of `asOf` (YYYY-MM-DD), from the reference endpoint. */
export async function getCallContractsAsOf(underlying: string, expirationDate: string, asOf: string): Promise<ChainContract[]> {
  const out: ChainContract[] = [];
  let url: string | undefined =
    `${BASE_URL}/v3/reference/options/contracts?underlying_ticker=${underlying}&contract_type=call` +
    `&expiration_date=${expirationDate}&as_of=${asOf}&limit=1000`;
  while (url) {
    const page: ContractsResponse = await getJson<ContractsResponse>(url);
    for (const r of page.results ?? []) out.push({ ticker: r.ticker, strikePrice: r.strike_price, expirationDate: r.expiration_date });
    url = page.next_url;
  }
  return out;
}

/** The company's shares outstanding (this share class), or undefined when Massive has none. */
export async function getSharesOutstanding(ticker: string): Promise<number | undefined> {
  const data = await getJson<{ results?: { share_class_shares_outstanding?: number } }>(`${BASE_URL}/v3/reference/tickers/${ticker}`);
  const shares = data.results?.share_class_shares_outstanding;
  return shares && shares > 0 ? shares : undefined;
}

/** Live last-trade price for a stock or option ticker. */
export async function getLastTradePrice(ticker: string): Promise<number> {
  const data = await getJson<{ results: { p: number } }>(`${BASE_URL}/v2/last/trade/${ticker}`);
  return data.results.p;
}

export interface ChainContract {
  ticker: string;
  strikePrice: number;
  expirationDate: string;
}

interface OptionsSnapshotResponse {
  results?: Array<{ details: { ticker: string; strike_price: number; expiration_date: string } }>;
  next_url?: string;
}

/** Call contracts for one expiration. Only used for the strike list - the snapshot's quotes can
 *  lag by tens of minutes, so pricing comes from getLiveOptionQuote. */
export async function getCallChain(underlying: string, expirationDate: string): Promise<ChainContract[]> {
  const out: ChainContract[] = [];
  let url: string | undefined =
    `${BASE_URL}/v3/snapshot/options/${underlying}?contract_type=call&expiration_date=${expirationDate}&limit=250`;
  while (url) {
    const page: OptionsSnapshotResponse = await getJson<OptionsSnapshotResponse>(url);
    for (const r of page.results ?? []) {
      out.push({
        ticker: r.details.ticker,
        strikePrice: r.details.strike_price,
        expirationDate: r.details.expiration_date,
      });
    }
    url = page.next_url;
  }
  return out;
}

export interface ChainQuote extends ChainContract {
  /** Today's last trade and volume; null / 0 if the contract hasn't traded today. */
  close: number | null;
  volume: number;
  bid: number | null;
  ask: number | null;
}

interface ChainSnapshotResponse {
  results?: Array<{
    details: { ticker: string; strike_price: number; expiration_date: string };
    day?: { close?: number; volume?: number };
    last_quote?: { bid?: number; ask?: number };
  }>;
  next_url?: string;
}

/** Every put or call expiring in [expFrom, expTo] with a strike in [strikeLow, strikeHigh], with today's trading. */
export async function getOptionChainQuotes(
  underlying: string,
  contractType: 'put' | 'call',
  expFrom: string,
  expTo: string,
  strikeLow: number,
  strikeHigh: number,
): Promise<ChainQuote[]> {
  const out: ChainQuote[] = [];
  let url: string | undefined =
    `${BASE_URL}/v3/snapshot/options/${underlying}?contract_type=${contractType}&expiration_date.gte=${expFrom}&expiration_date.lte=${expTo}` +
    `&strike_price.gte=${strikeLow}&strike_price.lte=${strikeHigh}&limit=250`;
  while (url) {
    const page: ChainSnapshotResponse = await getJson<ChainSnapshotResponse>(url);
    for (const r of page.results ?? []) {
      out.push({
        ticker: r.details.ticker,
        strikePrice: r.details.strike_price,
        expirationDate: r.details.expiration_date,
        close: r.day?.close ?? null,
        volume: r.day?.volume ?? 0,
        bid: r.last_quote?.bid ?? null,
        ask: r.last_quote?.ask ?? null,
      });
    }
    url = page.next_url;
  }
  return out;
}

export interface LiveOptionQuote {
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  lastTradePrice: number | null;
}

/** Live NBBO and last trade for a single option contract (e.g. "O:TSLA261019C00355000"). */
export async function getLiveOptionQuote(optionTicker: string): Promise<LiveOptionQuote> {
  const [quotes, lastTrade] = await Promise.all([
    getJson<{ results?: Array<{ bid_price?: number; ask_price?: number }> }>(
      `${BASE_URL}/v3/quotes/${optionTicker}?order=desc&sort=timestamp&limit=1`,
    ),
    getJson<{ results?: { p: number } }>(`${BASE_URL}/v2/last/trade/${optionTicker}`).catch(() => undefined),
  ]);
  const q = quotes.results?.[0];
  const bid = q?.bid_price ?? null;
  const ask = q?.ask_price ?? null;
  const midpoint = bid != null && ask != null && ask > 0 ? (bid + ask) / 2 : null;
  return { bid, ask, midpoint, lastTradePrice: lastTrade?.results?.p ?? null };
}
