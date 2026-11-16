// Entry and take-profit orders that outlive a single run, worked every 5 minutes.
//
// Entries (pendingEntries/{ticker_candle}): the backtest fills a signal at the option's last trade
// in the signal candle's final 5 minutes, or else at the close of the first of the next 200
// 5-minute bars that traded (the next morning's, after the day's last candle). Live, that's a buy
// limit at the option's bid/ask mid from the signal candle's close, moved to the new mid every 5
// minutes until it fills or the 200 bars run out - so it fills only when someone trades with us
// near the mid, like the backtest only fills when the option trades. DAY orders end at the bell
// and are placed again at the next morning's mid. Contracts are sized once, at the first mid,
// from the cash and account value at that moment.
//
// Take profit (takeProfitOrders/{tradeId}): once a strategy trade is open and past the signal
// candle's next closing window (the backtest's first take-profit check), a GOOD_TILL_CANCEL sell
// rests at entry × (1 + takeProfitMinGainPct). The forced and expiration exits cancel it first.
//
// Every step - placed, re-priced, partly filled, filled, expired at the bell, given up on,
// skipped - is a line in the run's text and an event in liveEvents (eventLog.ts).
import { logger } from 'firebase-functions';
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { db } from '../admin.js';
import { PENDING_ENTRIES_COLLECTION, loadAccountState } from '../account.js';
import { EventType, report } from '../eventLog.js';
import { MACDEXP } from '../strategy/config.js';
import { addDays, etParts } from '../strategy/history.js';
import { BAR_MS, EntrySignal, FIVE_MIN_MS, OpenTrade, sizeEntry, takeProfitPrice } from '../strategy/macdexpLive.js';
import { getLiveOptionQuote } from '../strategy/massive.js';
import { OrderStatus, cancelOrder, getOrder, placeOrder, schwabOptionSymbol } from './client.js';
import { ORDER_HINTS, recordOrders, syncBalances } from './sync.js';
import { contractLabel, maxOrderCost, money, placeWithFallback, roundToTick } from './ticks.js';

const PENDING = db.collection(PENDING_ENTRIES_COLLECTION);
const TAKE_PROFITS = db.collection('takeProfitOrders');
const FINISHED = ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED'];
// A run holds an entry this long while it works it, so two overlapping runs never both place.
const LEASE_MS = 3 * 60_000;

export interface PendingEntry {
  ticker: string;
  candleTime: string; // open time of the signal candle
  contractTicker: string; // O:...
  symbol: string; // Schwab's
  strike: number;
  expiration: string;
  capPct: number;
  boostRule: number;
  troughValue: number;
  /** End of the 200 five-minute bars after the signal candle. */
  windowEnd: string;
  estimatedCost: number | null;
  contracts: number | null; // sized at the first price
  filledQuantity: number; // contracts filled by orders already finished
  orderId: string | null; // the working order, if any
  limitPrice: number | null;
  pricedAt: string | null; // when the working order's limit was set from the mid
  status: 'waiting' | 'working' | 'done';
  outcome: string | null;
  leaseUntil: number;
  /** Contracts the working order had filled when last checked, so each partial fill is reported once. */
  workingFilled?: number;
  /** The EntrySignal that opened it: copied onto the trade (via ORDER_HINTS) for comparing with the backtest. */
  signal?: Record<string, unknown> | null;
}

const isoPlus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/** 9:30 ET on `date`, as an ISO instant (EDT or EST, whichever that date is in). */
function openOf(date: string): string {
  for (const offset of ['-04:00', '-05:00']) {
    const iso = new Date(`${date}T09:30:00${offset}`).toISOString();
    if (etParts(iso).minutes === 570) return iso;
  }
  return new Date(`${date}T13:30:00Z`).toISOString();
}

/** The next regular-hours candle after the signal candle: 30 minutes later, or the next weekday's open after 3:30. */
function nextCandleStart(candleTime: string): string {
  const { date, minutes } = etParts(candleTime);
  if (minutes + 30 < 960) return isoPlus(candleTime, BAR_MS);
  let d = addDays(date, 1);
  while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = addDays(d, 1);
  return openOf(d);
}

/** Whether Schwab takes regular-session orders right now (9:30-4:00 ET, weekdays). */
function marketOpen(nowMs: number): boolean {
  const { date, minutes } = etParts(new Date(nowMs));
  const day = new Date(date + 'T12:00:00Z').getUTCDay();
  return day !== 0 && day !== 6 && minutes >= 570 && minutes < 960;
}

/** Atomically takes the entry for this run; false if another run holds it or it's done. */
async function lease(ref: DocumentReference, nowMs: number): Promise<PendingEntry | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const e = snap.data() as PendingEntry | undefined;
    if (!e || e.status === 'done' || e.leaseUntil > nowMs) return null;
    tx.update(ref, { leaseUntil: nowMs + LEASE_MS });
    return e;
  });
}

interface WorkContext {
  nowMs: number;
  cash: number;
  accountValue: number;
  lines: string[];
}

/**
 * One step for one entry: settle the working order, stop if it filled or the window ran out,
 * otherwise (re)place the buy at the current bid/ask mid.
 */
async function workEntry(ref: DocumentReference, e: PendingEntry, ctx: WorkContext): Promise<Partial<PendingEntry>> {
  const label = contractLabel(e.ticker, e.expiration, e.strike);
  // Texts the line and logs the event with this entry's identifying fields.
  const say = (type: EventType, text: string, extra: Record<string, unknown> = {}) =>
    report(ctx.lines, {
      type, text, ticker: e.ticker, candleTime: e.candleTime, pendingEntry: ref.id, contractTicker: e.contractTicker,
      strike: e.strike, expiration: e.expiration, side: 'buy', contracts: e.contracts, ...extra,
    });
  const statusFields = (orderId: string, st: OrderStatus) => ({
    orderId, limitPrice: e.limitPrice, status: st.status, orderFilled: st.filledQuantity, avgFillPrice: st.avgFillPrice, fillTime: st.lastFillTime,
  });
  const update: Partial<PendingEntry> = {};
  let filled = e.filledQuantity;
  let working: OrderStatus | null = null;
  if (e.orderId) {
    const st = await getOrder(e.orderId);
    if (st.status === 'FILLED') {
      filled += st.filledQuantity;
      await say('order-filled', `BOUGHT ${filled}x ${label} @ ${money(st.avgFillPrice ?? e.limitPrice ?? 0)}`, { ...statusFields(e.orderId, st), filledQuantity: filled });
      return { filledQuantity: filled, orderId: null, status: 'done', outcome: 'filled' };
    }
    if (FINISHED.includes(st.status)) {
      filled += st.filledQuantity;
      Object.assign(update, { filledQuantity: filled, orderId: null, workingFilled: 0 });
      if (st.status === 'REJECTED') {
        await say('order-rejected', `${label}: BUY rejected by Schwab - entry dropped`, { ...statusFields(e.orderId, st), filledQuantity: filled });
        return { ...update, status: 'done', outcome: 'rejected' };
      }
      // Ended without us: a DAY order at the bell, or canceled by hand in Schwab.
      await say(
        'order-unfilled',
        `${label}: BUY @ ${money(e.limitPrice ?? 0)} ${st.status.toLowerCase()} with ${filled} of ${e.contracts} bought - placed again at the next mid`,
        { ...statusFields(e.orderId, st), filledQuantity: filled },
      );
    } else {
      working = st;
      if (st.filledQuantity > (e.workingFilled ?? 0)) {
        update.workingFilled = st.filledQuantity;
        await say(
          'order-partial',
          `BOUGHT ${filled + st.filledQuantity} of ${e.contracts}x ${label} so far @ ${money(st.avgFillPrice ?? e.limitPrice ?? 0)} - rest still working`,
          { ...statusFields(e.orderId, st), filledQuantity: filled + st.filledQuantity },
        );
      }
    }
  }
  const remainingOf = (contracts: number) => contracts - filled - (working?.filledQuantity ?? 0);

  // The 200 bars are up: cancel what's left. Whatever filled stays a trade.
  if (ctx.nowMs >= Date.parse(e.windowEnd)) {
    if (working && e.orderId) {
      await cancelOrder(e.orderId);
      filled += (await getOrder(e.orderId)).filledQuantity;
    }
    await say(
      'entry-expired',
      filled > 0
        ? `${label}: ${filled} of ${e.contracts} bought before the ${MACDEXP.entryFallback5MinBars} 5-min bars ran out - rest canceled`
        : `${label}: BUY never filled in ${MACDEXP.entryFallback5MinBars} 5-min bars - entry dropped`,
      { orderId: e.orderId, limitPrice: e.limitPrice, filledQuantity: filled },
    );
    return { filledQuantity: filled, orderId: null, status: 'done', outcome: filled > 0 ? 'partial' : 'expired' };
  }
  if (e.contracts != null && remainingOf(e.contracts) <= 0) return { ...update, status: 'done', outcome: 'filled' };
  if (!marketOpen(ctx.nowMs)) return { ...update, status: e.orderId && working ? 'working' : 'waiting' };

  const quote = await getLiveOptionQuote(e.contractTicker).catch(() => undefined);
  const mid = quote?.midpoint;
  if (!mid || mid <= 0) return { ...update, status: working ? 'working' : 'waiting' }; // no two-sided quote
  const quoteFields = { bid: quote?.bid ?? null, ask: quote?.ask ?? null, midpoint: mid };
  const quoteText = `bid ${quote?.bid != null ? money(quote.bid) : '?'} / ask ${quote?.ask != null ? money(quote.ask) : '?'}`;
  // The mid hasn't moved off the working order's price: leave it resting.
  if (working && [roundToTick(mid, 'up'), roundToTick(mid, 'up', 'coarse')].includes(e.limitPrice ?? -1)) return update;

  let contracts = e.contracts;
  if (contracts == null) {
    const sized = sizeEntry(mid, e.capPct, ctx.cash, ctx.accountValue);
    if (typeof sized === 'string') {
      await say('entry-skipped', `${label}: BUY skipped - ${sized}`, { ...quoteFields, cash: ctx.cash, accountValue: ctx.accountValue });
      return { ...update, status: 'done', outcome: `skipped: ${sized}` };
    }
    contracts = Math.min(sized, Math.floor(maxOrderCost() / (roundToTick(mid, 'up') * 100)));
    if (contracts < 1) {
      await say('entry-skipped', `${label}: BUY skipped - one contract is over SCHWAB_MAX_ORDER_COST`, quoteFields);
      return { ...update, status: 'done', outcome: 'skipped: over SCHWAB_MAX_ORDER_COST' };
    }
    update.contracts = contracts;
  }

  // Re-price: cancel the working order (counting anything it filled), then place at the new mid.
  // Its cost comes back to Schwab's cash, which ctx.cash didn't include.
  let freed = 0;
  const repricing = working != null;
  if (working && e.orderId) {
    freed = (e.limitPrice ?? 0) * remainingOf(contracts) * 100;
    await cancelOrder(e.orderId);
    const after = await getOrder(e.orderId);
    if (after.status === 'FILLED') {
      filled += after.filledQuantity;
      await say('order-filled', `BOUGHT ${filled}x ${label} @ ${money(after.avgFillPrice ?? e.limitPrice ?? 0)}`, { ...statusFields(e.orderId, after), filledQuantity: filled });
      return { ...update, filledQuantity: filled, orderId: null, status: 'done', outcome: 'filled' };
    }
    filled += after.filledQuantity;
    working = null;
    Object.assign(update, { filledQuantity: filled, orderId: null, workingFilled: 0 });
  }
  const quantity = contracts - filled;
  const pricedAt = new Date(ctx.nowMs).toISOString();
  if (quantity <= 0) return { ...update, status: 'done', outcome: 'filled' };

  const result = await placeWithFallback(
    (size) => {
      const limitPrice = roundToTick(mid, 'up', size);
      const cost = limitPrice * quantity * 100;
      if (cost > ctx.cash + freed) return `${money(cost)} is more than Schwab cash ${money(ctx.cash)}`;
      return { instruction: 'BUY_TO_OPEN', symbol: e.symbol, quantity, limitPrice };
    },
    label,
    // Saved the moment Schwab accepts it, so a failure later in this step can't lead to a second buy.
    async (order) => {
      const orderId = await placeOrder(order);
      await ref.update({ ...update, orderId, limitPrice: order.limitPrice, pricedAt, status: 'working', workingFilled: 0 });
      return orderId;
    },
  );
  if (typeof result === 'string') {
    await say('entry-skipped', `${label}: BUY skipped - ${result}`, quoteFields);
    return { ...update, status: 'done', outcome: `skipped: ${result}` };
  }
  // recordOpen copies the signal candle (holdBars counts from it) and the signal's readings onto the trade.
  await ORDER_HINTS.doc(result.orderId).set({ signalTime: e.candleTime, pendingEntry: ref.id, signal: e.signal ?? null, createdAt: new Date() });
  ctx.cash += freed - result.order.limitPrice * quantity * 100;
  const placed = { ...quoteFields, orderId: result.orderId, limitPrice: result.order.limitPrice, quantity, filledQuantity: filled };
  if (repricing) {
    await say('order-repriced', `${label}: BUY moved ${money(e.limitPrice ?? 0)} -> ${money(result.order.limitPrice)} (new mid; ${quoteText}), ${filled} of ${contracts} bought`, { ...placed, previousLimit: e.limitPrice });
  } else if (e.limitPrice == null) {
    await say('order-placed', `BUY ${quantity}x ${label} limit ${money(result.order.limitPrice)} placed at the mid (${quoteText}; moved to the new mid every 5 min for up to ${MACDEXP.entryFallback5MinBars} bars)`, placed);
  } else {
    await say('order-placed', `BUY ${quantity}x ${label} limit ${money(result.order.limitPrice)} placed again at this session's mid (${quoteText})`, placed);
  }
  return { ...update, orderId: result.orderId, limitPrice: result.order.limitPrice, pricedAt, status: 'working', workingFilled: 0 };
}

async function runEntry(ref: DocumentReference, ctx: WorkContext): Promise<void> {
  const e = await lease(ref, ctx.nowMs);
  if (!e) return;
  let update: Partial<PendingEntry>;
  try {
    update = await workEntry(ref, e, ctx);
  } catch (err) {
    logger.error(`Pending entry ${ref.id} failed this step`, err);
    await report(ctx.lines, {
      type: 'error', ticker: e.ticker, candleTime: e.candleTime, pendingEntry: ref.id, error: (err as Error).message,
      text: `${contractLabel(e.ticker, e.expiration, e.strike)}: BUY step FAILED - ${(err as Error).message.slice(0, 120)} (tried again in 5 min)`,
    });
    update = {};
  }
  await ref.update({ ...update, leaseUntil: 0, updatedAt: FieldValue.serverTimestamp() });
}

/**
 * Turns the alert scan's accepted signals into pending entries and places the first buy at each
 * option's current mid. Returns text lines.
 */
export async function createPendingEntries(signals: EntrySignal[]): Promise<string[]> {
  if (!signals.length) return [];
  const nowMs = Date.now();
  const balances = await syncBalances();
  const ctx: WorkContext = { nowMs, cash: balances.cashAvailable, accountValue: balances.accountValue, lines: [] };
  for (const s of signals) {
    if (!s.contractTicker || s.strike == null) {
      await report(ctx.lines, { type: 'entry-skipped', ticker: s.ticker, candleTime: s.candleTime, text: `${s.ticker}: BUY skipped - no contract in the strike band` });
      continue;
    }
    const entry: PendingEntry = {
      ticker: s.ticker,
      candleTime: s.candleTime,
      contractTicker: s.contractTicker,
      symbol: schwabOptionSymbol(s.ticker, s.expiration, s.strike),
      strike: s.strike,
      expiration: s.expiration,
      capPct: s.capPct,
      boostRule: s.boostRule,
      troughValue: s.troughValue,
      windowEnd: isoPlus(nextCandleStart(s.candleTime), MACDEXP.entryFallback5MinBars * FIVE_MIN_MS),
      estimatedCost: s.estimatedCost,
      contracts: null,
      filledQuantity: 0,
      orderId: null,
      limitPrice: null,
      pricedAt: null,
      status: 'waiting',
      outcome: null,
      leaseUntil: 0,
      workingFilled: 0,
      signal: JSON.parse(JSON.stringify(s)),
    };
    const ref = PENDING.doc(`${s.ticker}_${s.candleTime}`);
    try {
      await ref.create({ ...entry, createdAt: FieldValue.serverTimestamp() });
    } catch (err) {
      if ((err as { code?: number }).code === 6) continue; // ALREADY_EXISTS: an earlier pass has it
      throw err;
    }
    await runEntry(ref, ctx);
    const after = (await ref.get()).data() as PendingEntry;
    if (after.status === 'waiting') {
      await report(ctx.lines, {
        type: 'entry-waiting', ticker: s.ticker, candleTime: s.candleTime, pendingEntry: ref.id, contractTicker: s.contractTicker,
        text: `${contractLabel(s.ticker, s.expiration, s.strike)}: no bid/ask quote yet - buying at the mid once there is one`,
      });
    }
  }
  return ctx.lines;
}

/** Every waiting / working entry, one step each. */
async function workPendingEntries(ctx: WorkContext): Promise<void> {
  const snap = await PENDING.where('status', 'in', ['waiting', 'working']).get();
  const docs = snap.docs.sort((a, b) => Number(a.get('troughValue')) - Number(b.get('troughValue')));
  for (const d of docs) await runEntry(d.ref, ctx);
}

// ---- Take profit ----

interface TakeProfitDoc {
  orderId: string | null;
  label?: string;
  symbol: string;
  quantity: number;
  limitPrice: number;
  /** Set while another exit is selling the trade, so the take profit isn't put back meanwhile. */
  suspendedUntil?: number;
}
// How long a take profit stays off after another exit cancels it: that sell's fill window plus a margin.
const SUSPEND_MS = 6 * 60_000;

/**
 * Cancels the trade's resting take-profit sell before another exit sells it. 'filled' means the
 * take profit already sold it; the caller shouldn't sell again.
 */
export async function cancelTakeProfit(tradeId: string): Promise<'filled' | 'canceled' | 'none'> {
  const ref = TAKE_PROFITS.doc(tradeId);
  const tp = (await ref.get()).data() as TakeProfitDoc | undefined;
  let outcome: 'filled' | 'canceled' | 'none' = 'none';
  if (tp?.orderId) {
    let st = await getOrder(tp.orderId);
    if (!FINISHED.includes(st.status)) {
      await cancelOrder(tp.orderId);
      st = await getOrder(tp.orderId);
    }
    outcome = st.filledQuantity >= tp.quantity ? 'filled' : 'canceled';
  }
  await ref.set({ orderId: null, symbol: tp?.symbol ?? '', quantity: 0, limitPrice: 0, suspendedUntil: Date.now() + SUSPEND_MS });
  return outcome;
}

/** When a trade's take profit may start working: after its signal candle's next closing window. */
function takeProfitFrom(t: OpenTrade): number {
  if (!t.signalTime) return 0;
  const close = Date.parse(t.signalTime) + BAR_MS;
  return Math.max(Date.parse(t.openedAt), close + BAR_MS - MACDEXP.closeFillWindowMin * 60_000);
}

/** Places or re-sizes the resting take-profit sell for every open strategy trade; cancels orphans. */
async function workTakeProfits(ctx: WorkContext, heldBySymbol: Map<string, number>): Promise<void> {
  const account = await loadAccountState();
  const open = new Map(account.openTrades.map((t) => [t.id, t]));
  const existing = await TAKE_PROFITS.get();

  for (const d of existing.docs) {
    const tp = d.data() as TakeProfitDoc;
    if (open.has(d.id)) continue;
    if (tp.orderId) {
      const st = await getOrder(tp.orderId);
      const fields = {
        tradeId: d.id, orderId: tp.orderId, side: 'sell', exitType: 'take-profit', label: tp.label ?? tp.symbol,
        limitPrice: tp.limitPrice, quantity: tp.quantity, status: st.status, filledQuantity: st.filledQuantity, avgFillPrice: st.avgFillPrice, fillTime: st.lastFillTime,
      };
      if (st.status === 'FILLED') {
        await report(ctx.lines, { type: 'order-filled', ...fields, text: `SOLD ${st.filledQuantity}x ${tp.label ?? tp.symbol} @ ${money(st.avgFillPrice ?? tp.limitPrice)} (take profit)` });
      } else if (!FINISHED.includes(st.status)) {
        // The trade closed some other way (forced exit, by hand): its take profit has nothing to sell.
        await cancelOrder(tp.orderId);
        await report(ctx.lines, { type: 'order-canceled', ...fields, text: `${tp.label ?? tp.symbol}: take-profit SELL canceled - the trade was closed another way` });
      }
    }
    await d.ref.delete();
  }

  for (const t of open.values()) {
    if (ctx.nowMs < takeProfitFrom(t)) continue;
    const ref = TAKE_PROFITS.doc(t.id);
    const tp = (await ref.get()).data() as TakeProfitDoc | undefined;
    const symbol = schwabOptionSymbol(t.ticker, t.expiration, t.strike);
    const quantity = Math.min(t.contracts, heldBySymbol.get(symbol) ?? 0);
    if (tp?.suspendedUntil && tp.suspendedUntil > ctx.nowMs) continue;
    let resized = false;
    if (tp?.orderId) {
      const st = await getOrder(tp.orderId);
      if (st.status === 'FILLED') continue; // recordOrders closes the trade
      if (!FINISHED.includes(st.status) && tp.quantity === quantity) continue;
      if (!FINISHED.includes(st.status)) {
        await cancelOrder(tp.orderId);
        resized = true;
      }
    }
    if (quantity <= 0 || !marketOpen(ctx.nowMs)) continue;
    const label = contractLabel(t.ticker, t.expiration, t.strike);
    const target = takeProfitPrice(t.entryPrice);
    const fields = {
      ticker: t.ticker, candleTime: t.signalTime, tradeId: t.id, strike: t.strike, expiration: t.expiration, side: 'sell',
      exitType: 'take-profit', entryPrice: t.entryPrice, quantity,
    };
    try {
      const result = await placeWithFallback(
        (size) => ({ instruction: 'SELL_TO_CLOSE', symbol, quantity, limitPrice: roundToTick(target, 'up', size), duration: 'GOOD_TILL_CANCEL' }),
        label,
        // Saved the moment Schwab accepts it, so a failure later can't lead to a second sell.
        async (order) => {
          const orderId = await placeOrder(order);
          await ref.set({ orderId, label, symbol, quantity, limitPrice: order.limitPrice, createdAt: new Date() });
          return orderId;
        },
      );
      if (typeof result === 'string') continue;
      await ORDER_HINTS.doc(result.orderId).set({ exitType: 'take-profit', createdAt: new Date() });
      const px = money(result.order.limitPrice);
      const pct = `+${(MACDEXP.takeProfitMinGainPct * 100).toFixed(0)}%`;
      await report(ctx.lines, {
        type: resized ? 'order-repriced' : 'order-placed', ...fields, orderId: result.orderId, limitPrice: result.order.limitPrice,
        text: resized
          ? `${label}: take-profit SELL resized to ${quantity} @ ${px} (${tp?.quantity} -> ${quantity} held)`
          : `${label}: take-profit SELL ${quantity} @ ${px} resting (${pct} over entry ${money(t.entryPrice)})${tp?.orderId ? ' - placed again' : ''}`,
      });
    } catch (err) {
      logger.warn(`${label}: take-profit order failed`, { error: (err as Error).message });
      await report(ctx.lines, { type: 'order-failed', ...fields, error: (err as Error).message, text: `${label}: take-profit SELL FAILED to place - ${(err as Error).message.slice(0, 120)} (tried again in 5 min)` });
    }
  }
}

/**
 * The 5-minute step: records fills, works every pending entry, then keeps a take profit resting
 * on every open trade. Returns text lines for anything that happened.
 */
export async function workOrders(): Promise<string[]> {
  const nowMs = Date.now();
  const balances = await syncBalances();
  const ctx: WorkContext = { nowMs, cash: balances.cashAvailable, accountValue: balances.accountValue, lines: [] };
  await workPendingEntries(ctx);
  // Fills from this step (and any by hand) become trades before their take profits are placed.
  const after = await syncBalances();
  ctx.lines.push(...(await recordOrders(after.cashAvailable)).lines);
  const held = new Map(after.positions.filter((p) => p.assetType === 'OPTION').map((p) => [p.symbol, p.longQuantity]));
  await workTakeProfits({ ...ctx, cash: after.cashAvailable }, held);
  return ctx.lines;
}
