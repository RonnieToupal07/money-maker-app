// Every auto-trading event, one doc each in liveEvents, so live results can be lined up against
// the backtest's later: each candle's scan, every signal (traded, skipped by a filter, seen only
// at the close, or not confirmed by the close), every exit check, every order placed, re-priced
// or canceled, every fill or failure to fill, and every trade opened or closed with its P&L.
// `text` is the line that went out in the text message (or would have, for log-only events).
import { logger } from 'firebase-functions';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from './admin.js';

export const EVENTS_COLLECTION = 'liveEvents';

export type EventType =
  | 'scan'
  | 'signal' // an entry signal the auto-trader is buying
  | 'signal-skipped' // a MACD signal a filter or position rule blocked
  | 'signal-missed' // seen at the close but not 5 minutes before it, so not traded
  | 'signal-unconfirmed' // traded 5 minutes before the close, but the close itself didn't signal
  | 'exit-signal' // a forced / expiration exit being sold
  | 'exit-check' // every open trade's exit check at every candle (log only)
  | 'order-placed'
  | 'order-repriced'
  | 'order-canceled'
  | 'order-filled'
  | 'order-partial'
  | 'order-unfilled'
  | 'order-rejected'
  | 'order-failed'
  | 'entry-waiting'
  | 'entry-skipped'
  | 'entry-expired'
  | 'trade-opened'
  | 'trade-closed'
  | 'error';

export interface LiveEvent {
  type: EventType;
  text: string;
  ticker?: string;
  /** Open time of the 30-min candle that decided it. */
  candleTime?: string | null;
  [field: string]: unknown;
}

/**
 * Writes the event; never throws, so a logging hiccup can't stop an order. With `id`, the event
 * is written only once under that id (rescans of the same candle stay single); returns whether
 * this call wrote it.
 */
export async function logEvent(event: LiveEvent, id?: string): Promise<boolean> {
  // Round-trip through JSON: drops undefined fields, which Firestore refuses.
  const doc = { ...JSON.parse(JSON.stringify(event)), at: Timestamp.now(), createdAt: FieldValue.serverTimestamp() };
  try {
    if (id) await db.collection(EVENTS_COLLECTION).doc(id).create(doc);
    else await db.collection(EVENTS_COLLECTION).add(doc);
    return true;
  } catch (err) {
    if (id && (err as { code?: number }).code === 6) return false; // ALREADY_EXISTS: an earlier pass logged it
    logger.warn('Event log write failed', { type: event.type, error: (err as Error).message });
    return !id;
  }
}

/** Logs the event and adds its line to `lines`, the run's text message. */
export async function report(lines: string[], event: LiveEvent): Promise<void> {
  lines.push(event.text);
  await logEvent(event);
}
