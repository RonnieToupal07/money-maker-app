import { DocumentData, Timestamp } from 'firebase/firestore';

export interface Trade {
  id: string;
  ticker: string;
  strike: number;
  putCall: 'C' | 'P';
  exp: string;
  contracts: number;
  entryPrice: number;
  exitPrice: number | null;
  openedAt: string;
  closedAt: string | null;
  exitType: string;
  /** Realized P&L in dollars; null while the trade is still open. */
  pnl: number | null;
  /** Account cash right after opening / closing, as entered; null when not recorded. */
  cashAfterOpen: number | null;
  cashAfterClose: number | null;
  /** '' for trades entered here; schwab-import / schwab-auto for ones from Schwab. */
  source: string;
}

// Keep in sync with MACDEXP.holdBars / maxDaysToExpiration in functions/src/strategy/config.ts.
export const HOLD_CANDLES = 40;
export const MAX_DAYS_TO_EXPIRATION = 40;

const CANDLE_MS = 30 * 60_000;
const etFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Whether a regular-hours 30-min candle closes at `ms` (10:00 AM-4:00 PM ET, weekdays). */
function isCandleClose(ms: number): boolean {
  const p = Object.fromEntries(etFormat.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const minutes = Number(p['hour']) * 60 + Number(p['minute']);
  return p['weekday'] !== 'Sat' && p['weekday'] !== 'Sun' && minutes >= 600 && minutes <= 960;
}

/** A call bought within MAX_DAYS_TO_EXPIRATION of expiring - what the strategy trades and force-exits. */
export function isStrategyTrade(t: Trade): boolean {
  if (t.putCall !== 'C' || !t.exp || !t.openedAt) return false;
  const days = (Date.parse(`${t.exp}T00:00:00Z`) - Date.parse(`${t.openedAt.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
  return days <= MAX_DAYS_TO_EXPIRATION;
}

/**
 * 30-min candles closed since the trade's entry candle, up to `untilMs` - the same count the
 * exit check uses for the HOLD_CANDLES forced exit. The entry candle is the one whose close is
 * nearest the time the trade was opened. Market holidays aren't known here, so a holiday counts
 * its 13 candles until the trade is closed.
 */
export function candlesHeld(openedAt: string, untilMs: number): number {
  // Latest candle close at or before openedAt + 15 min.
  let entryClose = Math.floor((Date.parse(openedAt) + CANDLE_MS / 2) / CANDLE_MS) * CANDLE_MS;
  for (let i = 0; i < 48 * 7 && !isCandleClose(entryClose); i++) entryClose -= CANDLE_MS;

  let count = 0;
  for (let ms = entryClose + CANDLE_MS; ms <= untilMs && count < 1000; ms += CANDLE_MS) {
    if (isCandleClose(ms)) count++;
  }
  return count;
}

export interface TradeStats {
  start: number;
  end: number;
  pnl: number;
  returnPct: number;
  closed: number;
  open: number;
  winRate: number;
  wins: number;
  losses: number;
  /** Average P&L of a won trade; 0 when there are none. */
  avgWin: number;
  /** Average P&L of a lost trade (negative); 0 when there are none. */
  avgLoss: number;
}

function toIso(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value === 'string' && value) return new Date(value).toISOString();
  return null;
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return value == null || value === '' || Number.isNaN(n) ? null : n;
}

/** Maps a `trades` document to a Trade. Adjust field names here if the documents differ. */
export function fromDoc(id: string, d: DocumentData): Trade {
  const contracts = toNumber(d['contracts']) ?? 1;
  const entryPrice = toNumber(d['entryPrice']) ?? 0;
  const exitPrice = toNumber(d['exitPrice']);
  return {
    id,
    ticker: String(d['ticker'] ?? ''),
    strike: toNumber(d['strike']) ?? 0,
    putCall: d['putCall'] === 'P' ? 'P' : 'C',
    exp: String(d['exp'] ?? ''),
    contracts,
    entryPrice,
    exitPrice,
    openedAt: toIso(d['openedAt']) ?? '',
    closedAt: toIso(d['closedAt']),
    exitType: String(d['exitType'] ?? ''),
    pnl: toNumber(d['pnl']) ?? (exitPrice == null ? null : (exitPrice - entryPrice) * contracts * 100),
    cashAfterOpen: toNumber(d['cashAfterOpen']),
    cashAfterClose: toNumber(d['cashAfterClose']),
    // A trade matched to Schwab history keeps its schwabPositionKey even if it was entered here.
    source: String(d['source'] ?? (d['schwabPositionKey'] ? 'schwab-import' : '')),
  };
}

/** A manual "cash is now X" entry from the dashboard (`cashUpdates` collection). */
export interface CashUpdate {
  id: string;
  cash: number;
  at: string; // ISO
}

export function cashUpdateFromDoc(id: string, d: DocumentData): CashUpdate | null {
  const cash = toNumber(d['cash']);
  const at = toIso(d['at']);
  return cash == null || !at ? null : { id, cash, at };
}

/**
 * Free cash after every open and close so far. A recorded cashAfterOpen/cashAfterClose or a
 * manual cash update resets the running total to that value; trades without one move it by their
 * cost or proceeds.
 * Keep in sync with loadAccountState in functions/src/entries.ts.
 */
export function currentCash(trades: Trade[], start: number, updates: CashUpdate[] = []): number {
  const events: { time: string; delta: number; recorded: number | null }[] = updates.map((u) => ({
    time: u.at,
    delta: 0,
    recorded: u.cash,
  }));
  for (const t of trades) {
    events.push({ time: t.openedAt, delta: -t.entryPrice * t.contracts * 100, recorded: t.cashAfterOpen });
    if (t.exitPrice != null) {
      events.push({ time: t.closedAt ?? t.openedAt, delta: t.exitPrice * t.contracts * 100, recorded: t.cashAfterClose });
    }
  }
  events.sort((a, b) => a.time.localeCompare(b.time));
  return events.reduce((cash, e) => e.recorded ?? cash + e.delta, start);
}

/** A profitable trade, or a take-profit exit that broke even (e.g. filled at the entry price). */
export function isWin(t: Trade): boolean {
  const pnl = t.pnl ?? 0;
  return pnl > 0 || (pnl === 0 && t.exitType === 'take-profit');
}

export function tradeStats(trades: Trade[], start: number): TradeStats {
  const closed = trades.filter((t) => t.pnl != null);
  const pnl = closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const won = closed.filter(isWin);
  const lost = closed.filter((t) => !isWin(t));
  const wins = won.length;
  const avg = (ts: Trade[]) => (ts.length ? ts.reduce((sum, t) => sum + (t.pnl ?? 0), 0) / ts.length : 0);
  return {
    wins,
    losses: lost.length,
    avgWin: avg(won),
    avgLoss: avg(lost),
    start,
    end: start + pnl,
    pnl,
    returnPct: start ? (pnl / start) * 100 : 0,
    closed: closed.length,
    open: trades.length - closed.length,
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
  };
}
