// Option limit prices must sit on the contract's price increment. Penny-program options (nearly
// every ticker the strategy trades) allow $0.01 under $3 and $0.05 above; the rest need $0.05 /
// $0.10. Orders try the fine increment first and fall back to the coarse one if Schwab rejects it.
import { logger } from 'firebase-functions';
import type { OrderRequest } from './client.js';

export type TickSize = 'fine' | 'coarse';

export function tickFor(price: number, size: TickSize): number {
  if (size === 'fine') return price < 3 ? 0.01 : 0.05;
  return price < 3 ? 0.05 : 0.1;
}

/** Rounds onto the increment grid: buys round up and sells round down, toward the side that fills. */
export function roundToTick(price: number, direction: 'up' | 'down', size: TickSize = 'fine'): number {
  const tick = tickFor(price, size);
  const steps = price / tick;
  const rounded = (direction === 'up' ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9)) * tick;
  return Math.round(rounded * 100) / 100;
}

/** The lowest valid price strictly above `price` - the floor for a take-profit sell. */
export function tickAbove(price: number, size: TickSize = 'fine'): number {
  const tick = tickFor(price, size);
  return Math.round((Math.floor(price / tick + 1e-9) + 1) * tick * 100) / 100;
}

/**
 * Places the order built for the fine increment with `place`; if Schwab refuses it, rebuilds it
 * for the coarse increment and tries once more. `build` returns a reason string instead to skip.
 */
export async function placeWithFallback(
  build: (size: TickSize) => OrderRequest | string,
  label: string,
  place: (order: OrderRequest) => Promise<string>,
): Promise<{ order: OrderRequest; orderId: string } | string> {
  const fine = build('fine');
  if (typeof fine === 'string') return fine;
  try {
    return { order: fine, orderId: await place(fine) };
  } catch (err) {
    const coarse = build('coarse');
    if (typeof coarse === 'string') return coarse;
    if (coarse.limitPrice === fine.limitPrice) throw err;
    logger.warn(`${label}: $${fine.limitPrice} refused, retrying at $${coarse.limitPrice}`, { error: (err as Error).message });
    return { order: coarse, orderId: await place(coarse) };
  }
}

/** Optional hard cap on any single order's cost, from SCHWAB_MAX_ORDER_COST. */
export function maxOrderCost(): number {
  const cap = Number(process.env.SCHWAB_MAX_ORDER_COST);
  return Number.isFinite(cap) && cap > 0 ? cap : Infinity;
}

export const money = (n: number) => `$${n.toFixed(2)}`;
export const contractLabel = (ticker: string, expiration: string, strike: number) => `${ticker} ${expiration.slice(5)} $${strike}C`;
