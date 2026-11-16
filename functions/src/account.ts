import type { DocumentData } from 'firebase-admin/firestore';
import { CASH_UPDATES_COLLECTION, LOG_START, STARTING_ACCOUNT_VALUE, TRADES_COLLECTION, db } from './admin.js';
import { CONTRACT_MULTIPLIER, MACDEXP } from './strategy/config.js';
import { etParts } from './strategy/history.js';
import type { AccountState, OpenTrade } from './strategy/macdexpLive.js';

// Entries whose buy hasn't finished filling (see schwab/entryOrders.ts).
export const PENDING_ENTRIES_COLLECTION = 'pendingEntries';

export function toMillis(value: unknown): number {
  const date = (value as { toDate?: () => Date })?.toDate?.() ?? (value ? new Date(value as string) : null);
  return date ? date.getTime() : 0;
}

/**
 * A trade the sync imported from a Schwab BTO the app didn't place - logged before the sync left
 * those out. App-placed entries carry their signal candle; trades entered in the app aren't 'schwab'.
 */
const boughtByHand = (t: DocumentData) => t.source === 'schwab' && !t.signalTime;

/** A call bought within MACDEXP.maxDaysToExpiration of its expiration - what the strategy trades. */
export function isStrategyContract(t: DocumentData, openedAtMs: number): boolean {
  if ((t.putCall ?? 'C') !== 'C' || !t.exp) return false;
  const daysToExpiration = (Date.parse(`${t.exp}T00:00:00Z`) - Date.parse(`${etParts(new Date(openedAtMs)).date}T00:00:00Z`)) / 86_400_000;
  return daysToExpiration <= MACDEXP.maxDaysToExpiration;
}

function recordedCash(value: unknown): number | null {
  return value == null || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
}

/**
 * Free cash and open trades from the `trades` and `cashUpdates` collections, the same way the
 * dashboard counts them (currentCash in src/app/trades/trade.model.ts): every open, close and
 * manual cash update in time order, where a recorded cashAfterOpen/cashAfterClose or cash update
 * resets the total and other trades move it by cost/proceeds. Entries still waiting to fill hold
 * a position slot, and the ones with no working order yet hold their estimated cost too (a
 * working order's cost is already out of Schwab's cash).
 */
export async function loadAccountState(): Promise<AccountState> {
  const [snap, cashSnap, pendingSnap, brokerage] = await Promise.all([
    db.collection(TRADES_COLLECTION).get(),
    db.collection(CASH_UPDATES_COLLECTION).get(),
    db.collection(PENDING_ENTRIES_COLLECTION).where('status', 'in', ['waiting', 'working']).get(),
    db.collection('brokerage').doc('schwab').get(),
  ]);
  const openTickers = new Set<string>();
  const openTrades: OpenTrade[] = [];
  // Manual cash updates from the dashboard reset the total at that moment, like a recorded cashAfter*.
  const events: { time: number; delta: number; recorded: number | null }[] = cashSnap.docs.flatMap((doc) => {
    const time = toMillis(doc.get('at'));
    const cash = recordedCash(doc.get('cash'));
    return time && cash != null ? [{ time, delta: 0, recorded: cash }] : [];
  });
  const logStart = Date.parse(`${LOG_START}T00:00:00-05:00`);
  snap.docs.forEach((doc) => {
    const t: DocumentData = doc.data();
    const ticker = String(t.ticker ?? '').toUpperCase();
    const contracts = Number(t.contracts ?? 1);
    const entryPrice = Number(t.entryPrice ?? 0);
    const openedAt = toMillis(t.openedAt);
    if (openedAt < logStart) return;
    events.push({
      time: openedAt,
      delta: -entryPrice * contracts * CONTRACT_MULTIPLIER,
      recorded: recordedCash(t.cashAfterOpen),
    });
    if (t.exitPrice != null) {
      events.push({
        time: toMillis(t.closedAt) || openedAt,
        delta: Number(t.exitPrice) * contracts * CONTRACT_MULTIPLIER,
        recorded: recordedCash(t.cashAfterClose),
      });
    } else if (isStrategyContract(t, openedAt) && !boughtByHand(t)) {
      // Puts, longer-dated contracts and ones bought by hand in Schwab count toward cash but are
      // never exit-checked, auto-sold or counted against the strategy's position limits.
      openTickers.add(ticker);
      openTrades.push({
        id: doc.id,
        ticker,
        strike: Number(t.strike ?? 0),
        expiration: String(t.exp ?? ''),
        contracts,
        entryPrice,
        openedAt: new Date(openedAt).toISOString(),
        signalTime: t.signalTime ? String(t.signalTime) : null,
      });
    }
  });
  events.sort((a, b) => a.time - b.time);
  const cash = events.reduce((total, e) => e.recorded ?? total + e.delta, STARTING_ACCOUNT_VALUE);
  const reserved = pendingSnap.docs.reduce((sum, d) => sum + (d.get('orderId') ? 0 : Number(d.get('estimatedCost') ?? 0)), 0);
  const accountValue = Number(brokerage.get('accountValue') ?? 0);
  return {
    cashAvailable: cash - reserved,
    // Before the first Schwab sync, fall back to cash plus what the open trades cost.
    accountValue: accountValue > 0 ? accountValue : cash + openTrades.reduce((s, t) => s + t.entryPrice * t.contracts * CONTRACT_MULTIPLIER, 0),
    openTickers,
    openTrades,
    pendingTickers: pendingSnap.docs.map((d) => String(d.get('ticker'))),
  };
}
