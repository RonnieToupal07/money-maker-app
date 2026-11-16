// Places the strategy's exit orders with Schwab: forced and expiration sells, as DAY limit orders
// at the live midpoint rounded to a valid option tick; anything not filled within FILL_TIMEOUT_MS
// (4 min), or by the run's fillBy (15s before the candle's close), is canceled and the trade stays
// open for the next candle. Entries and take profits are worked by entryOrders.ts. Fills are
// written to `trades` by recordOrders, the same path that records orders placed by hand, so each
// one is only ever logged once. Every step is texted and logged to liveEvents (eventLog.ts).
import { logger } from 'firebase-functions';
import { LiveEvent, report } from '../eventLog.js';
import { MACDEXP } from '../strategy/config.js';
import type { ExitCheck } from '../strategy/macdexpLive.js';
import { db } from '../admin.js';
import { OrderRequest, OrderStatus, SCHWAB_COLLECTION, cancelOrder, getOrder, placeOrder, schwabOptionSymbol } from './client.js';
import { cancelTakeProfit } from './entryOrders.js';
import { ORDER_HINTS, recordOrders, syncBalances } from './sync.js';
import { TickSize, contractLabel, money, placeWithFallback, roundToTick } from './ticks.js';

export const FILL_TIMEOUT_MS = 4 * 60_000;
const POLL_MS = 2_000;
// Every order the auto-trader places, from the moment Schwab accepts it until its fills are in
// `trades`. If the function dies while waiting, cleanUpBotOrders (run by the order sync) finds
// the leftover, cancels it and records whatever filled.
const BOT_ORDERS = db.collection(SCHWAB_COLLECTION).doc('auth').collection('botOrders');

/** Places the order and remembers it before doing anything else. */
async function placeTracked(order: OrderRequest, label: string): Promise<string> {
  const orderId = await placeOrder(order);
  await BOT_ORDERS.doc(orderId).set({ ...order, label, placedAt: Date.now() });
  return orderId;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Placed {
  label: string;
  order: OrderRequest;
  orderId: string;
  exit: ExitCheck;
}

/** Polls every order until it's done or `deadline` passes, then cancels whatever's left. */
async function waitForFills(placed: Placed[], deadline: number): Promise<Map<string, OrderStatus>> {
  const done = new Map<string, OrderStatus>();
  const finished = (s: OrderStatus) => ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(s.status);
  while (done.size < placed.length && Date.now() < deadline) {
    await sleep(POLL_MS);
    for (const p of placed) {
      if (done.has(p.orderId)) continue;
      const status = await getOrder(p.orderId);
      if (finished(status)) done.set(p.orderId, status);
    }
  }
  for (const p of placed) {
    if (done.has(p.orderId)) continue;
    await cancelOrder(p.orderId);
    done.set(p.orderId, await getOrder(p.orderId)); // may have filled (partly) before the cancel landed
  }
  return done;
}

/** The fields every event about one exit carries. */
const exitFields = (x: ExitCheck) => ({
  ticker: x.ticker, candleTime: x.candleTime, tradeId: x.tradeId, strike: x.strike, expiration: x.expiration,
  exitType: x.exitType, entryPrice: x.entryPrice,
});

/** One event per placed sell, from how it ended. */
function fillEvents(placed: Placed[], statuses: Map<string, OrderStatus>): LiveEvent[] {
  return placed.map(({ label, order, orderId, exit }) => {
    const s = statuses.get(orderId)!;
    const base = { ...exitFields(exit), orderId, side: 'sell', limitPrice: order.limitPrice, quantity: order.quantity, status: s.status, filledQuantity: s.filledQuantity, avgFillPrice: s.avgFillPrice, fillTime: s.lastFillTime };
    if (!s.filledQuantity || s.avgFillPrice == null) {
      return {
        ...base,
        type: s.status === 'REJECTED' ? 'order-rejected' : 'order-unfilled',
        text: `${label}: SELL ${order.quantity} @ ${money(order.limitPrice)} NOT filled (${s.status}) - still open, tried again next candle`,
      };
    }
    const pnl = (s.avgFillPrice - exit.entryPrice) * s.filledQuantity * 100;
    const partial = s.filledQuantity < order.quantity ? ` - only ${s.filledQuantity} of ${order.quantity}, rest still open` : '';
    return {
      ...base,
      type: partial ? 'order-partial' : 'order-filled',
      pnl,
      text: `SOLD ${s.filledQuantity}x ${label} @ ${money(s.avgFillPrice)} (${exit.exitType}, ${pnl >= 0 ? '+' : '-'}${money(Math.abs(pnl))})${partial}`,
    };
  });
}

/**
 * Sells to close every forced exit, after canceling the trade's resting take profit. Expiration
 * exits are only sold when `sellExpiring` (the day's last candle, while the market is still open);
 * otherwise they settle on their own and are only reported.
 */
async function placeExits(
  exits: ExitCheck[],
  heldBySymbol: Map<string, number>,
  sellExpiring: boolean,
  lines: string[],
): Promise<Placed[]> {
  const placed: Placed[] = [];
  for (const x of exits) {
    const label = contractLabel(x.ticker, x.expiration, x.strike);
    const skip = (text: string) => report(lines, { type: 'order-failed', ...exitFields(x), text: `${label}: ${text}` });
    // Second guard (loadAccountState already filters these out): never sell a longer-dated contract.
    const daysToExpiration = (Date.parse(`${x.expiration}T00:00:00Z`) - Date.parse(x.openedAt.slice(0, 10) + 'T00:00:00Z')) / 86_400_000;
    if (!(daysToExpiration <= MACDEXP.maxDaysToExpiration)) {
      await skip(`SELL skipped - expires ${Math.round(daysToExpiration)} days after it was bought, not a strategy trade`);
      continue;
    }
    if (x.exitType === 'expiration' && !sellExpiring) {
      await report(lines, { type: 'exit-signal', ...exitFields(x), text: `${label}: expiration exit - settles at intrinsic, no order placed` });
      continue;
    }
    const symbol = schwabOptionSymbol(x.ticker, x.expiration, x.strike);
    const quantity = Math.min(x.contracts, heldBySymbol.get(symbol) ?? 0);
    if (quantity <= 0) {
      await skip(`SELL skipped - no Schwab position in ${symbol.replace(/\s+/g, ' ')}`);
      continue;
    }
    const mid = x.midpoint ?? x.optionPrice;
    const build = (size: TickSize): OrderRequest | string => {
      const limitPrice = mid != null ? roundToTick(mid, 'down', size) : 0;
      return limitPrice > 0 ? { instruction: 'SELL_TO_CLOSE', symbol, quantity, limitPrice } : 'no usable option price';
    };
    try {
      const tp = await cancelTakeProfit(x.tradeId);
      if (tp === 'filled') {
        await report(lines, { type: 'order-filled', ...exitFields(x), side: 'sell', text: `${label}: take profit already sold it - no ${x.exitType} sell needed` });
        continue;
      }
      if (tp === 'canceled') {
        await report(lines, { type: 'order-canceled', ...exitFields(x), side: 'sell', text: `${label}: resting take-profit canceled for the ${x.exitType} sell` });
      }
      const result = await placeWithFallback(build, label, (order) => placeTracked(order, label));
      if (typeof result === 'string') {
        await skip(`SELL skipped - ${result}`);
        continue;
      }
      await ORDER_HINTS.doc(result.orderId).set({ exitType: x.exitType, createdAt: new Date() });
      await report(lines, {
        type: 'order-placed', ...exitFields(x), side: 'sell', orderId: result.orderId, limitPrice: result.order.limitPrice, quantity,
        bid: x.bid, ask: x.ask, midpoint: x.midpoint,
        text: `SELL ${quantity}x ${label} limit ${money(result.order.limitPrice)} placed (${x.exitType}; bid ${x.bid != null ? money(x.bid) : '?'} / ask ${x.ask != null ? money(x.ask) : '?'})`,
      });
      placed.push({ label, exit: x, ...result });
    } catch (err) {
      await skip(`SELL order failed - ${(err as Error).message.slice(0, 120)}`);
    }
  }
  return placed;
}

/**
 * Waits for the orders, records whatever filled into `trades` with the new Schwab cash, and only
 * then forgets them - so a crash anywhere before this point leaves them for cleanUpBotOrders.
 */
async function settle(placed: Placed[], deadline: number): Promise<{ statuses: Map<string, OrderStatus>; cash: number; recorded: string[] }> {
  const statuses = await waitForFills(placed, deadline);
  const after = await syncBalances();
  const recorded = await recordOrders(after.cashAvailable);
  await Promise.all(placed.map((p) => BOT_ORDERS.doc(p.orderId).delete()));
  return { statuses, cash: after.cashAvailable, recorded: recorded.lines };
}

export interface ExecuteOptions {
  /** Cancel anything unfilled at this time instead of FILL_TIMEOUT_MS after placing. */
  fillBy?: number;
  /** Sell contracts whose exit is expiration instead of letting them settle (market still open). */
  sellExpiring?: boolean;
}

/** Places the exit sells and waits for them, recording whatever filled. */
export async function executeExits(exits: ExitCheck[], options: ExecuteOptions = {}): Promise<string[]> {
  const before = await syncBalances();
  const held = new Map(before.positions.filter((p) => p.assetType === 'OPTION').map((p) => [p.symbol, p.longQuantity]));
  const lines: string[] = [];
  const placed = await placeExits(exits, held, options.sellExpiring ?? false, lines);
  let cash = before.cashAvailable;

  if (placed.length) {
    const settled = await settle(placed, Math.min(Date.now() + FILL_TIMEOUT_MS, options.fillBy ?? Infinity));
    for (const e of fillEvents(placed, settled.statuses)) await report(lines, e);
    lines.push(...settled.recorded);
    cash = settled.cash;
  }
  lines.push(`Schwab cash now ${money(cash)}`);
  logger.info('Schwab execution', { lines });
  return lines;
}

/**
 * Backstop for a run that died while waiting on its orders: any bot order older than the fill
 * window plus a margin is canceled if it's still working, its fills are recorded into `trades`,
 * and a line per order is returned for a text. Called by the 5-minute order sync.
 */
export async function cleanUpBotOrders(): Promise<string[]> {
  const stale = (await BOT_ORDERS.get()).docs.filter((d) => Date.now() - Number(d.get('placedAt')) > FILL_TIMEOUT_MS + 2 * 60_000);
  if (!stale.length) return [];

  const lines: string[] = [];
  for (const d of stale) {
    const orderId = d.id;
    let status = await getOrder(orderId);
    if (!['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(status.status)) {
      await cancelOrder(orderId);
      status = await getOrder(orderId);
    }
    const label = String(d.get('label'));
    const verb = d.get('instruction') === 'BUY_TO_OPEN' ? 'BUY' : 'SELL';
    const filled = status.filledQuantity && status.avgFillPrice != null;
    await report(lines, {
      type: filled ? 'order-filled' : 'order-unfilled', orderId, side: verb.toLowerCase(), label,
      limitPrice: d.get('limitPrice'), quantity: d.get('quantity'), status: status.status,
      filledQuantity: status.filledQuantity, avgFillPrice: status.avgFillPrice, fillTime: status.lastFillTime, recovered: true,
      text: filled
        ? `${label}: ${verb} filled ${status.filledQuantity} @ ${money(status.avgFillPrice!)} (recovered)`
        : `${label}: ${verb} not filled - canceled (recovered)`,
    });
  }
  const after = await syncBalances();
  lines.push(...(await recordOrders(after.cashAvailable)).lines);
  await Promise.all(stale.map((d) => d.ref.delete()));
  logger.warn('Recovered unfinished bot orders', { lines });
  return lines;
}
