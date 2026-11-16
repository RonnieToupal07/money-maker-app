// The Bx-Trender put/call seller, on its own Schwab account (BX_SCHWAB_ACCOUNT_NUMBER) and its own
// collections. It never trades by itself: a daily scan texts what to open and close and writes
// suggestions, and an order only goes to Schwab when one is clicked in the app.
//   bxSuggestions   one doc per suggested open or close, with its order's status
//   bxTrades        one doc per opened position, from its fills
//   bxScans         each day's signals and why each did or didn't become a suggestion
//   bxEvents        every order step, as a text line
//   bxAccount/schwab   latest balances and short option positions
// BX_TRADING=live in functions/.env is required before a click can place an order.
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, requireSignIn } from './admin.js';
import { sendAlert } from './entries.js';
import {
  OrderRequest, OrderStatus, SchwabBalances, cancelOrder, getBalances, getFilledOptionOrders, getOrder, linkedAccountNumbers, placeOrder,
  schwabConfigured, schwabOptionSymbol,
} from './schwab/client.js';
import { TickSize, money, roundToTick } from './schwab/ticks.js';
import { BxDirection } from './strategy/bxConfig.js';
import { BxAccountInput, BxEntry, BxExit, BxScan, OpenBxTrade, checkTakeProfits, scanBx } from './strategy/bxLive.js';
import { etParts } from './strategy/history.js';
import { etToday, ivBefore, loadIvSeries } from './strategy/ivSeries.js';
import { getLastTradePrice, getLiveOptionQuote } from './strategy/massive.js';
import { daysBetween, houseMarginPct, perContractBuyingPower, takeProfitPct } from './strategy/bxRules.js';

export const BX_SUGGESTIONS = 'bxSuggestions';
export const BX_TRADES = 'bxTrades';
export const BX_SCANS = 'bxScans';
export const BX_EVENTS = 'bxEvents';
const ACCOUNT_DOC = db.collection('bxAccount').doc('schwab');
const APP_URL = 'https://ronnie-money-maker.web.app/bx-trades';

// An open is refused if the mid has dropped this far below what was suggested. Closes aren't
// checked: a position should still be closable when the price has run against it.
const MAX_ENTRY_SLIP = 0.1;
const STALE_PLACING_MS = 2 * 60_000;
// Days the market closes at 1 PM ET; the 2:30 PM CT scan would be after the close. Add each year's.
const EARLY_CLOSE_DAYS = ['2026-11-27', '2026-12-24'];
// The scan runs at 2:30 PM CT; a scan clicked in this window (CT minutes) counts as that scan.
const SCAN_WINDOW = { from: 14 * 60 + 25, to: 15 * 60 };

// 'withdrawn': a take-profit close whose trade fell back under the target before it was clicked;
// it goes back to 'pending' if a later check finds the trade at the target again.
type SuggestionStatus = 'pending' | 'placing' | 'working' | 'filled' | 'partial' | 'expired' | 'unknown' | 'withdrawn';

interface Suggestion {
  kind: 'open' | 'close';
  status: SuggestionStatus;
  date: string;
  ticker: string;
  direction: BxDirection;
  optionTicker: string;
  symbol: string;
  strike: number;
  expiration: string;
  contracts: number | null;
  /** The mid when suggested; the order uses the mid at the click. */
  proposedPrice: number | null;
  bid: number | null;
  ask: number | null;
  perContractBp?: number;
  reason: string;
  note: string;
  tradeId?: string;
  entryPrice?: number;
  orderId?: string;
  limitPrice?: number;
  quantity?: number;
  lastError?: string;
}

const putCall = (d: BxDirection) => (d === 'sell_put' ? 'P' : 'C');
const label = (s: { ticker: string; expiration: string; strike: number; direction: BxDirection }) =>
  `${s.ticker} ${s.expiration.slice(5).replace('-', '/')} $${s.strike}${putCall(s.direction)}`;

/** Logs the line to bxEvents; never throws, so a logging hiccup can't stop an order. */
async function logBx(text: string, fields: Record<string, unknown> = {}): Promise<void> {
  try {
    await db.collection(BX_EVENTS).add({ ...JSON.parse(JSON.stringify(fields)), text, at: FieldValue.serverTimestamp() });
  } catch (err) {
    logger.warn('Bx event log failed', { error: (err as Error).message });
  }
}

/** The new account's number, or null. Refuses the MACD account: this must never trade there. */
function bxAccountNumber(): string | null {
  const number = process.env.BX_SCHWAB_ACCOUNT_NUMBER;
  if (!number || !schwabConfigured()) return null;
  if (number === process.env.SCHWAB_ACCOUNT_NUMBER) throw new Error('BX_SCHWAB_ACCOUNT_NUMBER is the MACD account - it must be the new one');
  return number;
}

function requireTradingAccount(): string {
  if (process.env.BX_TRADING !== 'live') throw new HttpsError('failed-precondition', 'Bx trading is off: set BX_TRADING=live in functions/.env');
  const number = bxAccountNumber();
  if (!number) throw new HttpsError('failed-precondition', 'Set BX_SCHWAB_ACCOUNT_NUMBER in functions/.env');
  return number;
}

/** Regular trading hours, early closes included. Holidays aren't known here. */
function marketOpenNow(): boolean {
  const { minutes } = etParts(new Date());
  const weekday = new Date(`${etToday()}T12:00:00Z`).getUTCDay();
  const closeMinutes = EARLY_CLOSE_DAYS.includes(etToday()) ? 780 : 960;
  return weekday !== 0 && weekday !== 6 && minutes >= 570 && minutes < closeMinutes;
}

function requireMarketOpen(): void {
  if (!marketOpenNow()) {
    throw new HttpsError('failed-precondition', 'The market is closed - a DAY order placed now would wait for the next session.');
  }
}

async function syncAccount(number: string): Promise<SchwabBalances> {
  const b = await getBalances(number);
  await ACCOUNT_DOC.set({
    accountType: b.accountType,
    accountValue: b.accountValue,
    cashAvailable: b.cashAvailable,
    availableFunds: b.availableFunds,
    positions: b.positions.filter((p) => p.assetType === 'OPTION').map((p) => ({
      symbol: p.symbol, shortQuantity: p.shortQuantity, longQuantity: p.longQuantity, averagePrice: p.averagePrice, marketValue: p.marketValue,
      maintenanceRequirement: p.maintenanceRequirement,
    })),
    syncedAt: new Date(),
  });
  return b;
}

async function loadOpenTrades(): Promise<(OpenBxTrade & { lastExitCheck?: string })[]> {
  const snap = await db.collection(BX_TRADES).where('status', '==', 'open').get();
  return snap.docs.map((d) => ({ ...(d.data() as Omit<OpenBxTrade, 'id'>), id: d.id }));
}

// ---- Scan: suggestions and texts ----

function openSuggestion(e: BxEntry, day: string): Suggestion {
  return {
    kind: 'open', status: 'pending', date: day, ticker: e.ticker, direction: e.direction, optionTicker: e.optionTicker,
    symbol: schwabOptionSymbol(e.ticker, e.expiration, e.strike, putCall(e.direction)), strike: e.strike, expiration: e.expiration,
    contracts: e.contracts, proposedPrice: e.midpoint ?? e.closePrice, bid: e.bid, ask: e.ask, perContractBp: e.perContractBp,
    reason: e.direction === 'sell_put' ? 'Bx trough' : 'Bx peak',
    note: `score ${e.score.toFixed(0)} (${Math.round(e.sizingPct * 100)}% of account), Bx ${e.peakScore.toFixed(1)}, delta ${e.delta.toFixed(2)}, ${e.dte} DTE`,
  };
}

function closeSuggestion(x: BxExit, day: string): Suggestion {
  const t = x.trade;
  return {
    kind: 'close', status: 'pending', date: day, ticker: t.ticker, direction: t.direction, optionTicker: t.optionTicker,
    symbol: schwabOptionSymbol(t.ticker, t.expiration, t.strike, putCall(t.direction)), strike: t.strike, expiration: t.expiration,
    contracts: t.contracts, proposedPrice: x.mark, bid: x.quote.bid, ask: x.quote.ask, reason: x.reason ?? 'manual', note: x.note,
    tradeId: t.id, entryPrice: t.entryPrice,
  };
}

const openId = (e: BxEntry, day: string) => `${day}_open_${e.ticker}_${e.direction}`;
const closeId = (tradeId: string, day: string) => `${day}_close_${tradeId}`;

/** Creates the doc unless it's there already; returns whether this call created it. */
async function createOnce(id: string, s: Suggestion): Promise<boolean> {
  try {
    await db.collection(BX_SUGGESTIONS).doc(id).create({ ...JSON.parse(JSON.stringify(s)), createdAt: new Date() });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 6) return false; // ALREADY_EXISTS
    throw err;
  }
}

const EXIT_LABELS: Record<string, string> = {
  take_profit: 'Take profit', stop_loss: 'Stop loss', dte_exit: 'Days to expiry', expiration_risk: 'Expiring - assignment risk',
};

function openLine(s: Suggestion, e: BxEntry): string {
  const size = s.contracts != null ? `${s.contracts}x` : '(no account to size)';
  const margin = s.contracts != null ? `, margin ~$${Math.round(e.perContractBp * s.contracts)}` : '';
  return `SELL ${size} ${label(s)} ~${s.proposedPrice != null ? money(s.proposedPrice) : '?'}${margin}. ${s.note}`;
}

function closeLine(s: Suggestion, x: BxExit): string {
  const pnl = x.mark != null ? (x.trade.entryPrice - x.mark) * x.trade.contracts * 100 : null;
  return `BUY ${x.trade.contracts}x ${label(s)} ~${x.mark != null ? money(x.mark) : '?'}, sold ${money(x.trade.entryPrice)}` +
    `${pnl != null ? ` (${pnl >= 0 ? '+' : '-'}${money(Math.abs(pnl))})` : ''}. ${EXIT_LABELS[x.reason!]}: ${x.note}`;
}

/** The trade's premium kept at this price, as text: "+22.4%" or "-8.1%". */
const keptPct = (x: BxExit) =>
  x.mark != null && x.trade.entryPrice ? `${((x.trade.entryPrice - x.mark) / x.trade.entryPrice) * 100 >= 0 ? '+' : ''}${(((x.trade.entryPrice - x.mark) / x.trade.entryPrice) * 100).toFixed(1)}%` : '?';

const targetPct = (t: OpenBxTrade, day: string) => `${Math.round(takeProfitPct(t.direction, daysBetween(day, t.expiration)) * 100)}%`;

/**
 * Keeps today's close suggestion for each checked trade in step with its price, at most one doc per
 * trade per day:
 *   reaches an exit, none yet       -> suggested (texted)
 *   reaches an exit, was withdrawn  -> suggested again (texted)
 *   still at the exit               -> price and note refreshed, quietly
 *   take profit no longer met       -> withdrawn (texted, so an earlier text isn't acted on)
 * Only a suggestion still waiting on a click changes; one with an order sent or done is left alone.
 * An exit without a price can't be judged either way, so it's skipped. Returns the lines to text.
 */
async function reconcileCloses(exits: BxExit[], day: string): Promise<string[]> {
  const lines: string[] = [];
  for (const x of exits) {
    if (x.mark == null) continue;
    const ref = db.collection(BX_SUGGESTIONS).doc(closeId(x.trade.id, day));
    const line = await db.runTransaction(async (tx): Promise<string | null> => {
      const doc = await tx.get(ref);
      const status = doc.get('status') as SuggestionStatus | undefined;
      if (x.reason) {
        const s = closeSuggestion(x, day);
        if (!doc.exists) {
          tx.create(ref, { ...JSON.parse(JSON.stringify(s)), createdAt: new Date() });
          return closeLine(s, x);
        }
        if (status === 'withdrawn') {
          tx.set(ref, { ...JSON.parse(JSON.stringify(s)), createdAt: doc.get('createdAt') ?? new Date(), reflaggedAt: new Date() });
          return `BACK AT TARGET: ${closeLine(s, x)}`;
        }
        if (status === 'pending') {
          tx.update(ref, { reason: x.reason, note: x.note, proposedPrice: x.mark, bid: x.quote.bid, ask: x.quote.ask, checkedAt: new Date() });
        }
        return null;
      }
      if (status === 'pending' && doc.get('reason') === 'take_profit') {
        const note = `fell back under the ${targetPct(x.trade, day)} target: now ${keptPct(x)} of premium at ~${money(x.mark!)}`;
        tx.update(ref, {
          status: 'withdrawn', note, proposedPrice: x.mark, bid: x.quote.bid, ask: x.quote.ask, withdrawnAt: new Date(), lastError: FieldValue.delete(),
        });
        return `WITHDRAWN: ${label(x.trade)} take profit - ${note}. Don't close on the earlier text.`;
      }
      return null;
    });
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * The 30-minute check and the Sync button judge take profits only; stop-loss and days-to-expiry
 * exits stay with the daily scan, so here they count as "no exit" (which can't withdraw them).
 */
const takeProfitsOnly = (exits: BxExit[]): BxExit[] => exits.map((x) => (x.reason === 'take_profit' ? x : { ...x, reason: null }));

/** Writes the scan's suggestions and texts the new ones: opens and closes as separate messages. */
export async function publishScan(scan: BxScan, trades: (OpenBxTrade & { lastExitCheck?: string })[]): Promise<void> {
  const { day } = scan;
  const pending = await db.collection(BX_SUGGESTIONS).where('status', '==', 'pending').get();
  await Promise.all(pending.docs.filter((d) => d.get('date') < day).map((d) => d.ref.update({ status: 'expired' })));

  await db.collection(BX_SCANS).doc(day).set({
    day, spyRegime: scan.spyRegime, checks: JSON.parse(JSON.stringify(scan.checks)), failed: scan.failed,
    exits: scan.exits.map((x) => ({ tradeId: x.trade.id, ticker: x.trade.ticker, reason: x.reason, note: x.note, mark: x.mark })),
    scannedAt: new Date(),
  });

  const opens: string[] = [];
  for (const e of scan.entries) {
    const s = openSuggestion(e, day);
    if (await createOnce(openId(e, day), s)) opens.push(openLine(s, e));
  }
  const closes = await reconcileCloses(scan.exits, day);
  // The stop-loss delay is counted once per trading day, however many scans run.
  await Promise.all(scan.exits.map(async (x) => {
    const trade = trades.find((t) => t.id === x.trade.id);
    if (trade?.lastExitCheck === day) return;
    await db.collection(BX_TRADES).doc(x.trade.id).update({ stopDelayDaysUsed: x.stopDelayDaysUsed, lastExitCheck: day });
  }));

  if (opens.length) await sendAlert(`Bx Seller OPEN:\n${opens.join('\n')}\n${APP_URL}`);
  if (closes.length) await sendAlert(`Bx Seller CLOSE:\n${closes.join('\n')}\n${APP_URL}`);
}

async function runScan(): Promise<{ scan: BxScan; trades: (OpenBxTrade & { lastExitCheck?: string })[] }> {
  const number = bxAccountNumber();
  let account: BxAccountInput | null = null;
  if (number) {
    const b = await syncAccount(number);
    account = { accountValue: b.accountValue, availableFunds: b.availableFunds };
  }
  const trades = await loadOpenTrades();
  return { scan: await scanBx(etToday(), account, trades), trades };
}

const scanOptions = { timeoutSeconds: 540, memory: '1GiB' as const };

/** 2:30 PM CT on weekdays: 30 minutes to act before the close, which is what the backtest trades on. */
export const bxDailyScan = onSchedule(
  { schedule: '30 14 * * 1-5', timeZone: 'America/Chicago', ...scanOptions, maxInstances: 1, retryCount: 0 },
  async () => {
    if (EARLY_CLOSE_DAYS.includes(etToday())) return;
    try {
      const { scan, trades } = await runScan();
      await publishScan(scan, trades);
      if (scan.failed.length) logger.warn('Bx scan had failures', { failed: scan.failed });
    } catch (err) {
      if ((err as Error).message.startsWith('No SPY bars')) return; // a market holiday
      logger.error('Bx scan failed', err);
      await sendAlert(`Bx Seller scan FAILED: ${(err as Error).message.slice(0, 200)}. Open the app and tap Scan to retry.\n${APP_URL}`).catch(() => undefined);
    }
  },
);

/**
 * Every 30 minutes through the session: suggests (and texts) a take-profit close as soon as a trade
 * reaches its target, instead of only at the 2:30 PM scan. A trade whose close went unclicked
 * yesterday gets a new suggestion today if it's still at its target. The 2:30 PM run is left to
 * the daily scan, which also handles stop-loss and days-to-expiry exits.
 */
export const bxTakeProfitCheck = onSchedule(
  { schedule: '0,30 8-14 * * 1-5', timeZone: 'America/Chicago', timeoutSeconds: 300, memory: '1GiB', maxInstances: 1, retryCount: 0 },
  async () => {
    if (!marketOpenNow()) return;
    const minutes = ctMinutes();
    if (minutes >= SCAN_WINDOW.from && minutes <= SCAN_WINDOW.to && !EARLY_CLOSE_DAYS.includes(etToday())) return;
    try {
      const trades = await loadOpenTrades();
      if (!trades.length) return;
      const day = etToday();
      const lines = await reconcileCloses(takeProfitsOnly(await checkTakeProfits(day, trades)), day);
      if (lines.length) await sendAlert(`Bx Seller CLOSE:\n${lines.join('\n')}\n${APP_URL}`);
    } catch (err) {
      logger.error('Bx take-profit check failed', err);
    }
  },
);

const ctMinutes = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
};

/**
 * The page's Scan button. Inside the 2:25-3:00 PM CT window it counts as the day's scan; any other
 * time it's only a preview, since the backtest decides on the close and a morning signal may vanish.
 */
export const bxScanNow = onCall(scanOptions, async (request) => {
  requireSignIn(request);
  try {
    const { scan, trades } = await runScan();
    const minutes = ctMinutes();
    const published = minutes >= SCAN_WINDOW.from && minutes <= SCAN_WINDOW.to;
    if (published) await publishScan(scan, trades);
    return {
      published,
      day: scan.day,
      spyRegime: scan.spyRegime,
      checks: scan.checks,
      failed: scan.failed,
      exits: scan.exits.map((x) => ({ ticker: x.trade.ticker, tradeId: x.trade.id, reason: x.reason, note: x.note, mark: x.mark })),
    };
  } catch (err) {
    logger.error('bxScanNow failed', err);
    throw new HttpsError('internal', (err as Error).message);
  }
});

// ---- Orders ----

const isSchwabRefusal = (err: unknown) => /^Schwab POST .* failed 4\d\d/.test((err as Error).message);

/** Places at the fine price increment; if Schwab refuses it, once more at the coarse one. Only a
 *  definite refusal is retried, because a lost response may mean the order went through. */
async function placeWithTicks(build: (size: TickSize) => OrderRequest, number: string): Promise<{ order: OrderRequest; orderId: string }> {
  const fine = build('fine');
  try {
    return { order: fine, orderId: await placeOrder(fine, number) };
  } catch (err) {
    const coarse = build('coarse');
    if (!isSchwabRefusal(err) || coarse.limitPrice === fine.limitPrice) throw err;
    return { order: coarse, orderId: await placeOrder(coarse, number) };
  }
}

/** Sends the suggestion to Schwab as a DAY limit order at the live mid, exactly once. */
async function placeSuggestion(id: string, number: string): Promise<{ orderId: string; limitPrice: number; quantity: number }> {
  const ref = db.collection(BX_SUGGESTIONS).doc(id);
  // Claimed in a transaction so a double click, or two devices, can't send two orders.
  const s = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const data = doc.data() as Suggestion | undefined;
    if (!data) throw new HttpsError('not-found', 'That suggestion no longer exists.');
    if (data.status !== 'pending') throw new HttpsError('failed-precondition', `Already ${data.status}.`);
    if (data.date !== etToday()) throw new HttpsError('failed-precondition', `That suggestion is from ${data.date}, not today.`);
    if (!data.contracts) throw new HttpsError('failed-precondition', 'No contract count - the account wasn\'t connected when it was suggested.');
    tx.update(ref, { status: 'placing', placingAt: Date.now(), lastError: FieldValue.delete() });
    return data;
  });

  const refuse = async (reason: string): Promise<never> => {
    await ref.update({ status: 'pending', lastError: reason });
    await logBx(`${label(s)}: ${s.kind} refused - ${reason}`, { suggestionId: id });
    throw new HttpsError('failed-precondition', reason);
  };

  let built: { order: OrderRequest; orderId: string };
  let sent = false;
  try {
    const [quote, balances] = await Promise.all([getLiveOptionQuote(s.optionTicker), getBalances(number)]);
    const mid = quote.midpoint;
    if (mid == null || mid <= 0) return await refuse('No live bid and ask for this contract.');
    const isOpen = s.kind === 'open';
    let quantity = s.contracts!;

    if (isOpen) {
      if (s.proposedPrice != null && mid < s.proposedPrice * (1 - MAX_ENTRY_SLIP)) {
        return await refuse(`Mid ${money(mid)} is over 10% below the suggested ${money(s.proposedPrice)}.`);
      }
      const required = (s.perContractBp ?? 0) * quantity;
      const cap = Number(process.env.BX_MAX_ORDER_MARGIN);
      if (Number.isFinite(cap) && cap > 0 && required > cap) return await refuse(`Margin ~${money(required)} is over BX_MAX_ORDER_MARGIN (${money(cap)}).`);
      if (balances.availableFunds != null && required > balances.availableFunds) {
        return await refuse(`Needs ~${money(required)} of margin but Schwab shows ${money(balances.availableFunds)} available.`);
      }
    } else {
      const held = balances.positions.find((p) => p.symbol === s.symbol)?.shortQuantity ?? 0;
      quantity = Math.min(quantity, held);
      if (quantity <= 0) return await refuse(`Schwab shows no short position in ${s.symbol.replace(/\s+/g, ' ')}.`);
    }

    const build = (size: TickSize): OrderRequest => ({
      instruction: isOpen ? 'SELL_TO_OPEN' : 'BUY_TO_CLOSE',
      symbol: s.symbol,
      quantity,
      limitPrice: roundToTick(mid, isOpen ? 'down' : 'up', size),
    });
    sent = true;
    built = await placeWithTicks(build, number);
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (!sent || isSchwabRefusal(err)) return await refuse((err as Error).message.slice(0, 300));
    // The response was lost, so the order may be live at Schwab. Never retry this automatically.
    await ref.update({ status: 'unknown', lastError: (err as Error).message.slice(0, 300) });
    await logBx(`${label(s)}: order state UNKNOWN - ${(err as Error).message.slice(0, 200)}`, { suggestionId: id });
    await sendAlert(`Bx Seller: ${label(s)} order state unknown - check Schwab before doing anything else.`).catch(() => undefined);
    throw new HttpsError('unknown', 'Schwab didn\'t confirm the order. Check Schwab before trying again.');
  }

  const { order, orderId } = built;
  await ref.update({ status: 'working', orderId, limitPrice: order.limitPrice, quantity: order.quantity, placedAt: Date.now() });
  await logBx(`${order.instruction} ${order.quantity}x ${label(s)} limit ${money(order.limitPrice)} placed`, { suggestionId: id, orderId });
  return { orderId, limitPrice: order.limitPrice, quantity: order.quantity };
}

/** The page's Open / Close button on a suggestion. */
export const bxPlaceOrder = onCall<{ suggestionId?: string }>({ timeoutSeconds: 60 }, async (request) => {
  requireSignIn(request);
  const number = requireTradingAccount();
  requireMarketOpen();
  const id = request.data?.suggestionId;
  if (!id) throw new HttpsError('invalid-argument', 'suggestionId is required');
  return placeSuggestion(id, number);
});

/** The page's Close button on an open trade with no suggestion today. */
export const bxCloseTrade = onCall<{ tradeId?: string }>({ timeoutSeconds: 60 }, async (request) => {
  requireSignIn(request);
  const number = requireTradingAccount();
  requireMarketOpen();
  const tradeId = request.data?.tradeId;
  if (!tradeId) throw new HttpsError('invalid-argument', 'tradeId is required');
  const doc = await db.collection(BX_TRADES).doc(tradeId).get();
  if (doc.get('status') !== 'open') throw new HttpsError('failed-precondition', 'That trade isn\'t open.');
  const trade = { ...(doc.data() as Omit<OpenBxTrade, 'id'>), id: doc.id };
  const day = etToday();
  const quote = await getLiveOptionQuote(trade.optionTicker);
  const manual = closeSuggestion({ trade, reason: null, note: 'closed by hand', quote, mark: quote.midpoint, stopDelayDaysUsed: trade.stopDelayDaysUsed }, day);
  if (!(await createOnce(closeId(tradeId, day), manual))) {
    // Today's take profit was withdrawn: closing by hand anyway turns that doc into this close.
    const ref = db.collection(BX_SUGGESTIONS).doc(closeId(tradeId, day));
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.get('status') === 'withdrawn') tx.set(ref, { ...JSON.parse(JSON.stringify(manual)), createdAt: existing.get('createdAt') ?? new Date() });
    });
  }
  return placeSuggestion(closeId(tradeId, day), number);
});

// ---- Fills ----

const FINISHED = ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'];

/** Writes a finished order's fills to bxTrades, once. Returns the line to text, if any. */
async function recordFinished(id: string, status: OrderStatus): Promise<string | null> {
  const ref = db.collection(BX_SUGGESTIONS).doc(id);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const s = doc.data() as Suggestion | undefined;
    if (!s || s.status !== 'working') return null;
    const filled = status.filledQuantity, price = status.avgFillPrice;
    // Firestore needs every read in a transaction done before its first write.
    const tradeRef = s.kind === 'close' ? db.collection(BX_TRADES).doc(s.tradeId!) : null;
    const trade = tradeRef ? ((await tx.get(tradeRef)).data() as (OpenBxTrade & { realizedPnl?: number }) | undefined) : undefined;

    if (!filled || price == null) {
      // Back to pending so it can be clicked again today; the next scan expires it after that.
      const why = status.statusDescription ? ` Schwab says: ${status.statusDescription}` : '';
      tx.update(ref, { status: 'pending', orderId: FieldValue.delete(), lastError: `Order ${status.status.toLowerCase()}, nothing filled.${why}` });
      return `${label(s)}: ${s.kind} order ${status.status.toLowerCase()}, nothing filled.${why}`;
    }

    const whole = filled >= (s.quantity ?? 0);

    if (s.kind === 'open') {
      tx.update(ref, { status: whole ? 'filled' : 'partial', filledQuantity: filled, avgFillPrice: price });
      tx.create(db.collection(BX_TRADES).doc(s.orderId!), {
        status: 'open', ticker: s.ticker, direction: s.direction, optionTicker: s.optionTicker, symbol: s.symbol, strike: s.strike,
        expiration: s.expiration, contracts: filled, openedContracts: filled, entryDate: s.date, entryPrice: price, entryOrderId: s.orderId,
        entryFillTime: status.lastFillTime, buyingPower: (s.perContractBp ?? 0) * filled, stopDelayDaysUsed: 0, realizedPnl: 0, note: s.note, openedAt: new Date(),
      });
      return `SOLD ${filled}x ${label(s)} @ ${money(price)}${whole ? '' : ` (only ${filled} of ${s.quantity})`}`;
    }

    if (!trade || !tradeRef) {
      tx.update(ref, { status: whole ? 'filled' : 'partial', filledQuantity: filled, avgFillPrice: price });
      return `${label(s)}: bought back ${filled} @ ${money(price)} but its trade is missing - check bxTrades`;
    }
    const pnl = (trade.entryPrice - price) * filled * 100;
    const left = trade.contracts - filled;
    // What's left of a partly filled close stays clickable, so a stop isn't stuck until tomorrow.
    tx.update(ref, left > 0
      ? { status: 'pending', contracts: left, orderId: FieldValue.delete(), lastError: `${filled} bought back at ${money(price)}, ${left} still open.` }
      : { status: 'filled', filledQuantity: filled, avgFillPrice: price });
    const realizedPnl = (trade.realizedPnl ?? 0) + pnl;
    tx.update(tradeRef, {
      contracts: left, realizedPnl, buyingPower: trade.contracts ? (trade.buyingPower * left) / trade.contracts : 0,
      ...(left <= 0
        ? { status: 'closed', exitDate: s.date, exitPrice: price, exitReason: s.reason, exitOrderId: s.orderId, exitFillTime: status.lastFillTime, closedAt: new Date() }
        : {}),
    });
    return `BOUGHT ${filled}x ${label(s)} @ ${money(price)} (${pnl >= 0 ? '+' : '-'}${money(Math.abs(pnl))})${left > 0 ? `, ${left} still open` : ''}`;
  });
}

const isNotFound = (err: unknown) => / failed 404:/.test((err as Error).message);

/**
 * Finds an order in this strategy's account, else in the other linked accounts - an order placed
 * before BX_SCHWAB_ACCOUNT_NUMBER changed lives in the account the strategy used then.
 */
async function findOrder(orderId: string, number: string): Promise<{ status: OrderStatus; account: string }> {
  try {
    return { status: await getOrder(orderId, number), account: number };
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  for (const other of (await linkedAccountNumbers()).filter((n) => n !== number)) {
    try {
      return { status: await getOrder(orderId, other), account: other };
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  throw new Error(`Order ${orderId} isn't in any linked Schwab account`);
}

async function syncOrders(number: string): Promise<string[]> {
  const lines: string[] = [];
  const working = await db.collection(BX_SUGGESTIONS).where('status', '==', 'working').get();
  for (const d of working.docs) {
    // One order Schwab can't find mustn't stop the rest of the sync.
    try {
      const { status } = await findOrder(String(d.get('orderId')), number);
      if (!FINISHED.includes(status.status)) continue;
      const line = await recordFinished(d.id, status);
      if (line) {
        lines.push(line);
        await logBx(line, { suggestionId: d.id });
      }
    } catch (err) {
      logger.warn('Bx order check failed', { suggestionId: d.id, error: (err as Error).message });
      await d.ref.update({ lastError: `Couldn't check the order at Schwab: ${(err as Error).message.slice(0, 200)}` });
    }
  }
  // A run that died between claiming a suggestion and hearing back from Schwab.
  const placing = await db.collection(BX_SUGGESTIONS).where('status', '==', 'placing').get();
  for (const d of placing.docs) {
    if (Date.now() - Number(d.get('placingAt')) < STALE_PLACING_MS) continue;
    await d.ref.update({ status: 'unknown', lastError: 'The order step stopped before Schwab confirmed it.' });
    lines.push(`${d.get('ticker')}: ${d.get('kind')} order state unknown - check Schwab`);
  }
  return lines;
}

const SCHWAB_ORDER_HISTORY_DAYS = 60;

/**
 * Closes the open trades that were bought back by hand in Schwab. Only trades Schwab no longer
 * shows short in this strategy's account are looked up, in every linked account's order history
 * (a trade can sit in the account the strategy used before), so a hand trade in some other
 * contract is never touched. A buy-to-close counts if it filled after the trade opened and isn't
 * one of the app's own close orders.
 */
async function recordHandCloses(balances: SchwabBalances): Promise<string[]> {
  const open = (await db.collection(BX_TRADES).where('status', '==', 'open').get()).docs.filter((d) =>
    (balances.positions.find((p) => p.symbol === d.get('symbol'))?.shortQuantity ?? 0) <= 0);
  if (!open.length) return [];

  const from = new Date(Date.now() - SCHWAB_ORDER_HISTORY_DAYS * 86_400_000);
  const orders = (await Promise.all((await linkedAccountNumbers()).map((n) => getFilledOptionOrders(from, new Date(), n)))).flat()
    .filter((o) => o.instruction === 'BUY_TO_CLOSE');
  const appOrderIds = new Set((await db.collection(BX_SUGGESTIONS).where('kind', '==', 'close').get()).docs
    .map((d) => d.get('orderId')).filter(Boolean).map(String));

  const lines: string[] = [];
  for (const d of open) {
    const opened = String(d.get('entryFillTime') ?? `${d.get('entryDate')}T00:00:00Z`);
    const fills = orders
      .filter((o) => o.symbol === d.get('symbol') && o.fillTime >= opened && !appOrderIds.has(o.orderId))
      .sort((a, b) => a.fillTime.localeCompare(b.fillTime));
    if (!fills.length) continue;
    const line = await db.runTransaction(async (tx) => {
      const snap = await tx.get(d.ref);
      const t = snap.data() as (OpenBxTrade & { status: string; realizedPnl?: number; handCloseOrderIds?: string[] }) | undefined;
      if (!t || t.status !== 'open') return null;
      const used = new Set(t.handCloseOrderIds ?? []);
      let left = t.contracts, pnl = 0, cost = 0, bought = 0, last: (typeof fills)[number] | undefined;
      for (const f of fills) {
        if (left <= 0 || used.has(f.orderId)) continue;
        const qty = Math.min(f.filledQuantity, left);
        pnl += (t.entryPrice - f.avgFillPrice!) * qty * 100;
        cost += f.avgFillPrice! * qty;
        bought += qty;
        left -= qty;
        used.add(f.orderId);
        last = f;
      }
      if (!last) return null;
      const price = cost / bought;
      tx.update(d.ref, {
        contracts: left, realizedPnl: (t.realizedPnl ?? 0) + pnl, handCloseOrderIds: [...used],
        buyingPower: t.contracts ? (t.buyingPower * left) / t.contracts : 0,
        ...(left <= 0
          ? {
              status: 'closed', exitDate: etParts(new Date(last.fillTime)).date, exitPrice: Math.round(price * 100) / 100, exitReason: 'manual',
              exitOrderId: last.orderId, exitFillTime: last.fillTime, missingAtSchwab: false, closedAt: new Date(),
            }
          : {}),
      });
      return `${label(t)}: bought back ${bought} by hand in Schwab @ ${money(price)} (${pnl >= 0 ? '+' : '-'}${money(Math.abs(pnl))})` +
        `${left > 0 ? `, ${left} still open` : ' - trade closed'}`;
    });
    if (line) {
      lines.push(line);
      await logBx(line, { tradeId: d.id });
    }
  }
  return lines;
}

/** Flags open trades Schwab no longer shows short: expired, assigned, or closed outside the app. */
async function flagMissing(balances: SchwabBalances): Promise<string[]> {
  const lines: string[] = [];
  const open = await db.collection(BX_TRADES).where('status', '==', 'open').get();
  for (const d of open.docs) {
    const held = balances.positions.find((p) => p.symbol === d.get('symbol'))?.shortQuantity ?? 0;
    const missing = held <= 0;
    if (missing === !!d.get('missingAtSchwab')) continue;
    await d.ref.update({ missingAtSchwab: missing });
    if (missing) lines.push(`${d.get('ticker')} $${d.get('strike')}: open here but not at Schwab - expired, assigned, or closed elsewhere?`);
  }
  return lines;
}

/** Every 5 minutes through the session, offset from the MACD order sync so they don't share a refresh. */
export const bxOrderSync = onSchedule(
  { schedule: '2-59/5 8-15 * * 1-5', timeZone: 'America/Chicago', timeoutSeconds: 120, maxInstances: 1, retryCount: 0 },
  async () => {
    let number: string | null;
    try {
      number = bxAccountNumber();
    } catch (err) {
      logger.error('Bx order sync: bad account config', err);
      return;
    }
    if (!number) return;
    try {
      const lines = await syncOrders(number);
      const balances = await syncAccount(number);
      lines.push(...(await recordHandCloses(balances)), ...(await flagMissing(balances)));
      if (lines.length) await sendAlert(`Bx Seller:\n${lines.join('\n')}`);
    } catch (err) {
      logger.warn('Bx order sync failed', { error: (err as Error).message });
    }
  },
);

/** The page's Cancel button on a working order, and its Sync button. */
export const bxCancelOrder = onCall<{ suggestionId?: string }>({ timeoutSeconds: 60 }, async (request) => {
  requireSignIn(request);
  const number = bxAccountNumber();
  if (!number) throw new HttpsError('failed-precondition', 'Set BX_SCHWAB_ACCOUNT_NUMBER in functions/.env');
  const id = request.data?.suggestionId;
  if (!id) throw new HttpsError('invalid-argument', 'suggestionId is required');
  const doc = await db.collection(BX_SUGGESTIONS).doc(id).get();
  if (doc.get('status') !== 'working') throw new HttpsError('failed-precondition', 'That order isn\'t working.');
  const orderId = String(doc.get('orderId'));
  const { account } = await findOrder(orderId, number);
  await cancelOrder(orderId, account);
  const line = await recordFinished(id, await getOrder(orderId, account));
  if (line) await logBx(line, { suggestionId: id });
  return { line };
});

export interface MarginLeg {
  pct: number;
  /** Per contract, in dollars. */
  amount: number;
}

export interface MarginDetail {
  ticker: string;
  direction: BxDirection;
  strike: number;
  contracts: number;
  spot: number | null;
  mark: number | null;
  otm: number | null;
  iv: number | null;
  housePct: number;
  /** The app's rule, at today's price: the larger of the two legs, per contract. */
  app: { priceLeg: MarginLeg; strikeLeg: MarginLeg; perContract: number; total: number } | null;
  /** The industry minimum (FINRA/Cboe) at today's price, for comparison. */
  standard: { priceLeg: number; floorLeg: number; perContract: number; total: number } | null;
  /** What the app reserved when the trade filled. */
  atEntry: number;
  /** Schwab's live requirement for the position, straight from the positions data. */
  schwab: number | null;
  schwabQuantity: number;
  fetchedAt: string;
  notes: string[];
}

/**
 * The margin popover: re-reads the position from Schwab (for its maintenanceRequirement) and the
 * stock's last trade, and works the margin formula out at today's price.
 */
export const bxMarginDetail = onCall<{ tradeId?: string }>({ timeoutSeconds: 60 }, async (request): Promise<MarginDetail> => {
  requireSignIn(request);
  const number = bxAccountNumber();
  if (!number) throw new HttpsError('failed-precondition', 'Set BX_SCHWAB_ACCOUNT_NUMBER in functions/.env');
  const id = request.data?.tradeId;
  if (!id) throw new HttpsError('invalid-argument', 'tradeId is required');
  const doc = await db.collection(BX_TRADES).doc(id).get();
  if (!doc.exists) throw new HttpsError('not-found', 'That trade is gone.');
  const t = doc.data() as { ticker: string; direction: BxDirection; strike: number; contracts: number; symbol: string; buyingPower: number };
  const notes: string[] = [];

  const [balances, spot, ivSeries] = await Promise.all([
    syncAccount(number),
    getLastTradePrice(t.ticker).catch((err: Error) => { notes.push(`Couldn't get ${t.ticker}'s price: ${err.message}`); return null; }),
    loadIvSeries(t.ticker).catch(() => undefined),
  ]);
  const position = balances.positions.find((p) => p.symbol === t.symbol && p.shortQuantity > 0);
  if (!position) notes.push('Schwab shows no short position for this contract.');
  else if (position.maintenanceRequirement == null) notes.push('Schwab didn\'t include a margin requirement for this position.');

  const mark = position ? Math.abs(position.marketValue) / position.shortQuantity / 100 : null;
  const iv = ivBefore(ivSeries, etToday()) ?? null;
  const housePct = houseMarginPct(iv ?? undefined);
  const isPut = t.direction === 'sell_put';
  let app: MarginDetail['app'] = null, standard: MarginDetail['standard'] = null, otm: number | null = null;
  if (spot != null && mark != null) {
    otm = isPut ? Math.max(spot - t.strike, 0) : Math.max(t.strike - spot, 0);
    const pricePct = Math.max(0.2, housePct), strikePct = Math.max(0.3, housePct);
    const priceLeg = { pct: pricePct, amount: (pricePct * spot - otm + mark) * 100 };
    const strikeLeg = { pct: strikePct, amount: strikePct * t.strike * 100 };
    const perContract = perContractBuyingPower(t.direction, spot, t.strike, mark, housePct);
    app = { priceLeg, strikeLeg, perContract, total: perContract * t.contracts };
    const stdPrice = (0.2 * spot - otm + mark) * 100, stdFloor = (0.1 * (isPut ? t.strike : spot) + mark) * 100;
    const stdPer = Math.max(stdPrice, stdFloor);
    standard = { priceLeg: stdPrice, floorLeg: stdFloor, perContract: stdPer, total: stdPer * t.contracts };
  } else if (mark == null) {
    notes.push('No option price, so the formula can\'t be worked out.');
  }

  return {
    ticker: t.ticker, direction: t.direction, strike: t.strike, contracts: t.contracts, spot, mark, otm, iv, housePct,
    app, standard, atEntry: t.buyingPower, schwab: position?.maintenanceRequirement ?? null,
    schwabQuantity: position?.shortQuantity ?? 0, fetchedAt: new Date().toISOString(), notes,
  };
});

export const bxSync = onCall({ timeoutSeconds: 120 }, async (request) => {
  requireSignIn(request);
  const number = bxAccountNumber();
  if (!number) throw new HttpsError('failed-precondition', 'Set BX_SCHWAB_ACCOUNT_NUMBER in functions/.env');
  try {
    const lines = await syncOrders(number);
    const balances = await syncAccount(number);
    lines.push(...(await recordHandCloses(balances)), ...(await flagMissing(balances)));
    // While the market's open, Sync also re-checks take profits at live prices: flags or withdraws.
    if (marketOpenNow()) {
      const trades = await loadOpenTrades();
      if (trades.length) lines.push(...(await reconcileCloses(takeProfitsOnly(await checkTakeProfits(etToday(), trades)), etToday())));
    }
    return { lines };
  } catch (err) {
    logger.error('bxSync failed', err);
    throw new HttpsError('internal', (err as Error).message);
  }
});
