// Keeps Firestore in step with the Schwab account.
//   brokerage/schwab   latest cash, account value and open strategy contracts, for the dashboard
//   cashUpdates        a checkpoint whenever Schwab's cash changes, so every cash calculation
//                      (dashboard, Look For Trades, alerts) starts from the real number
//   trades             every filled BTO the auto-trader placed opens a trade, as does one matching a
//                      trade entered in the app; a BTO placed by hand in Schwab with neither is left
//                      out, so the strategy never manages it. Every filled STC closes a logged trade,
//                      including one sold by hand.
//
// Only the strategy's contracts count: long options (buy to open / sell to close) expiring
// within MAX_DAYS_TO_EXPIRATION of when they were bought. Short options (sell to open / buy to
// close) and longer-dated contracts are ignored.
import { logger } from 'firebase-functions';
import { FieldValue, Timestamp, type DocumentData, type DocumentSnapshot } from 'firebase-admin/firestore';
import { CASH_UPDATES_COLLECTION, LOG_START, TRADES_COLLECTION, db } from '../admin.js';
import { LiveEvent, logEvent } from '../eventLog.js';
import { MACDEXP } from '../strategy/config.js';
import { etParts } from '../strategy/history.js';
import { FilledOptionOrder, SCHWAB_COLLECTION, SchwabBalances, getBalances, getFilledOptionOrders, refreshExpiresAt } from './client.js';
import { contractLabel, money } from './ticks.js';

export const BROKERAGE_DOC = db.collection('brokerage').doc('schwab');
export const MAX_DAYS_TO_EXPIRATION = MACDEXP.maxDaysToExpiration;
// The auto-trader leaves the exit type (take-profit / forced) here when it places a sell, and the
// signal candle (signalTime) plus the signal's readings (signal) when it places a buy, so
// whichever process records the fill labels the trade with them.
export const ORDER_HINTS = db.collection(SCHWAB_COLLECTION).doc('auth').collection('orderHints');

const trades = db.collection(TRADES_COLLECTION);
// A fill this recent gets the current Schwab cash as its "cash after"; older ones are left blank.
const FRESH_FILL_MS = 10 * 60_000;

/** "TSLA  261023C00400000" → TSLA, 2026-10-23, 400, C. */
export function parseSymbol(symbol: string): { ticker: string; exp: string; strike: number; putCall: 'C' | 'P' } {
  const yymmdd = symbol.slice(6, 12);
  return {
    ticker: symbol.slice(0, 6).trim(),
    exp: `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`,
    putCall: symbol.charAt(12) === 'P' ? 'P' : 'C',
    strike: Number(symbol.slice(13)) / 1000,
  };
}

const daysBetween = (from: string, to: string) => (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface BalanceSync extends SchwabBalances {
  syncedAt: string;
}

/** An open strategy contract as the dashboard shows it (brokerage/schwab.positions). */
export interface OptionPosition {
  symbol: string;
  ticker: string;
  strike: number;
  exp: string;
  putCall: 'C' | 'P';
  description: string;
  quantity: number;
  averagePrice: number; // per share
  marketValue: number;
  openProfitLoss: number;
  dayProfitLoss: number | null;
}

/** Long options expiring within MAX_DAYS_TO_EXPIRATION; short and longer-dated ones are ignored. */
function optionPositions(balances: SchwabBalances, today: string): OptionPosition[] {
  return balances.positions
    .filter((p) => p.assetType === 'OPTION' && p.longQuantity > 0)
    .map((p) => ({
      symbol: p.symbol,
      ...parseSymbol(p.symbol),
      description: p.description,
      quantity: p.longQuantity,
      averagePrice: p.averagePrice,
      marketValue: p.marketValue,
      openProfitLoss: p.openProfitLoss ?? p.marketValue - p.averagePrice * p.longQuantity * 100,
      dayProfitLoss: p.dayProfitLoss,
    }))
    .filter((p) => daysBetween(today, p.exp) <= MAX_DAYS_TO_EXPIRATION)
    .sort((a, b) => a.exp.localeCompare(b.exp) || a.ticker.localeCompare(b.ticker));
}

/** Reads Schwab's balances and open contracts, saves them for the dashboard, and checkpoints cash if it changed. */
export async function syncBalances(): Promise<BalanceSync> {
  const balances = await getBalances();
  const previous = (await BROKERAGE_DOC.get()).data();
  const now = new Date();
  await BROKERAGE_DOC.set({
    accountType: balances.accountType,
    cashAvailable: balances.cashAvailable,
    accountValue: balances.accountValue,
    positions: optionPositions(balances, etParts(now).date),
    syncedAt: Timestamp.fromDate(now),
    refreshExpiresAt: await refreshExpiresAt(),
  });
  if (previous?.cashAvailable !== balances.cashAvailable) {
    await db.collection(CASH_UPDATES_COLLECTION).add({
      cash: balances.cashAvailable,
      at: Timestamp.fromDate(now),
      source: 'schwab',
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  return { ...balances, syncedAt: now.toISOString() };
}

interface Fill extends FilledOptionOrder {
  ticker: string;
  strike: number;
  exp: string;
  putCall: 'C' | 'P';
}

/** The strategy's fills: BTO/STC, expiring within MAX_DAYS_TO_EXPIRATION of the fill. */
export function strategyFills(orders: FilledOptionOrder[]): Fill[] {
  return orders
    .filter((o) => o.instruction === 'BUY_TO_OPEN' || o.instruction === 'SELL_TO_CLOSE')
    .map((o) => ({ ...o, ...parseSymbol(o.symbol) }))
    .filter((f) => daysBetween(etParts(f.fillTime).date, f.exp) <= MAX_DAYS_TO_EXPIRATION)
    .sort((a, b) => a.fillTime.localeCompare(b.fillTime));
}

const sameContract = (d: DocumentSnapshot, f: Fill) =>
  Number(d.get('strike')) === f.strike && (d.get('putCall') ?? 'C') === f.putCall;
const etDate = (value: unknown) => {
  const date = (value as { toDate?: () => Date })?.toDate?.();
  return date ? etParts(date).date : null;
};
const isOpen = (d: DocumentSnapshot) => d.get('exitPrice') == null && d.get('pnl') == null;

type Outcome = 'recorded' | 'matched' | 'exists' | 'ignored';
/** What a recorded fill did to `trades`, for the event log (and, for closes, the text). */
type Recorded = { outcome: Outcome; events: LiveEvent[] };

/**
 * A BTO fill opens a trade, under a doc id derived from the order so it can only be recorded
 * once. A trade entered by hand for the same contract that day is linked and corrected to the
 * fill instead of being duplicated. A fill with neither an order hint (every order the app places
 * leaves one) nor such a trade was bought by hand in Schwab, and is ignored.
 */
async function recordOpen(f: Fill, cash: number | null, hint: DocumentData | undefined): Promise<Recorded> {
  const ref = trades.doc(`schwab_${f.orderId}`);
  const signalTime: string | undefined = hint?.signalTime;
  return db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return { outcome: 'exists', events: [] };
    const sameExp = (await tx.get(trades.where('ticker', '==', f.ticker).where('exp', '==', f.exp))).docs.filter((d) => sameContract(d, f));
    if (sameExp.some((d) => d.get('schwabOpenOrderId') === f.orderId)) return { outcome: 'exists', events: [] };

    const fill = {
      contracts: f.filledQuantity,
      entryPrice: round2(f.avgFillPrice!),
      openedAt: Timestamp.fromDate(new Date(f.fillTime)),
      schwabSymbol: f.symbol,
      schwabOpenOrderId: f.orderId,
      ...(signalTime ? { signalTime } : {}),
      // The signal's readings (trough, RSI, slope, filters, quote at the signal), to line the trade up with the backtest's.
      ...(hint?.signal ? { signal: hint.signal } : {}),
    };
    const day = etParts(f.fillTime).date;
    const handEntered = sameExp.find((d) => !d.get('schwabOpenOrderId') && etDate(d.get('openedAt')) === day);
    if (!handEntered && !hint) return { outcome: 'ignored', events: [] };
    const event: LiveEvent = {
      type: 'trade-opened', ticker: f.ticker, candleTime: signalTime ?? null, strike: f.strike, expiration: f.exp,
      orderId: f.orderId, contracts: f.filledQuantity, entryPrice: fill.entryPrice, fillTime: f.fillTime,
      tradeId: handEntered?.id ?? ref.id, signal: hint?.signal ?? null,
      text: `OPENED ${f.filledQuantity}x ${contractLabel(f.ticker, f.exp, f.strike)} @ ${money(fill.entryPrice)}`,
    };
    if (handEntered) {
      tx.update(handEntered.ref, fill);
      return { outcome: 'matched', events: [event] };
    }
    tx.set(ref, {
      ticker: f.ticker,
      strike: f.strike,
      exp: f.exp,
      putCall: f.putCall,
      ...fill,
      closedAt: null,
      exitPrice: null,
      exitType: '',
      pnl: null,
      cashAfterOpen: cash,
      cashAfterClose: null,
      source: 'schwab',
      createdAt: FieldValue.serverTimestamp(),
    });
    return { outcome: 'recorded', events: [event] };
  });
}

/**
 * An STC fill closes the contract's open trades oldest first; a trade with more contracts than
 * were sold is split, keeping the rest open. If the trade was already closed by hand in the app
 * that day, the fill is linked to it and its exit price corrected.
 */
async function recordClose(f: Fill, cash: number | null, hint: string | undefined): Promise<Recorded> {
  return db.runTransaction(async (tx) => {
    const docs = (await tx.get(trades.where('ticker', '==', f.ticker).where('exp', '==', f.exp))).docs.filter((d) => sameContract(d, f));
    if (docs.some((d) => d.get('schwabCloseOrderId') === f.orderId)) return { outcome: 'exists', events: [] };

    const exitPrice = round2(f.avgFillPrice!);
    const closedAt = Timestamp.fromDate(new Date(f.fillTime));
    const label = contractLabel(f.ticker, f.exp, f.strike);
    const closeEvent = (d: DocumentSnapshot, contracts: number, exitType: string, pnl: number): LiveEvent => {
      const entryPrice = Number(d.get('entryPrice'));
      const pct = entryPrice > 0 ? (exitPrice / entryPrice - 1) * 100 : null;
      return {
        type: 'trade-closed', ticker: f.ticker, candleTime: d.get('signalTime') ?? null, strike: f.strike, expiration: f.exp,
        tradeId: d.id, orderId: f.orderId, contracts, entryPrice, exitPrice, exitType, pnl, pnlPct: pct,
        openedAt: d.get('openedAt')?.toDate?.().toISOString() ?? null, fillTime: f.fillTime, signal: d.get('signal') ?? null,
        text: `CLOSED ${contracts}x ${label}: ${money(entryPrice)} -> ${money(exitPrice)}, ` +
          `${pnl >= 0 ? '+' : '-'}${money(Math.abs(pnl))}${pct != null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : ''} ${exitType}`,
      };
    };
    const open = docs.filter(isOpen).sort((a, b) => a.get('openedAt')?.toMillis?.() - b.get('openedAt')?.toMillis?.());
    if (!open.length) {
      const day = etParts(f.fillTime).date;
      const handClosed = docs.find((d) => !isOpen(d) && !d.get('schwabCloseOrderId') && etDate(d.get('closedAt')) === day);
      if (!handClosed) return { outcome: 'ignored', events: [] }; // opened before LOG_START, or never logged
      const pnl = round2((exitPrice - Number(handClosed.get('entryPrice'))) * Number(handClosed.get('contracts')) * 100);
      tx.update(handClosed.ref, { exitPrice, closedAt, pnl, schwabCloseOrderId: f.orderId });
      return { outcome: 'matched', events: [closeEvent(handClosed, Number(handClosed.get('contracts')), handClosed.get('exitType') || 'manual', pnl)] };
    }

    const events: LiveEvent[] = [];
    let remaining = f.filledQuantity;
    for (const d of open) {
      if (remaining <= 0) break;
      const contracts = Number(d.get('contracts'));
      const sold = Math.min(contracts, remaining);
      if (sold < contracts) {
        tx.set(trades.doc(), { ...d.data(), contracts: contracts - sold, cashAfterOpen: null, createdAt: FieldValue.serverTimestamp() });
      }
      const exitType = d.get('exitType') || hint || 'manual';
      const pnl = round2((exitPrice - Number(d.get('entryPrice'))) * sold * 100);
      tx.update(d.ref, {
        contracts: sold,
        exitPrice,
        closedAt,
        exitType,
        pnl,
        cashAfterClose: cash,
        schwabCloseOrderId: f.orderId,
      });
      events.push(closeEvent(d, sold, exitType, pnl));
      remaining -= sold;
    }
    return { outcome: 'recorded', events };
  });
}

export interface RecordResult {
  opened: number;
  closed: number;
  matched: number;
  ignored: number;
  /** One text line per trade closed (with its P&L); opens are already texted as BOUGHT lines. */
  lines: string[];
}

/**
 * Records every strategy BTO/STC filled since LOG_START into `trades`, and logs each trade it
 * opens or closes to liveEvents. Safe to run any number of times, from any function: each order
 * is only ever applied once.
 */
export async function recordOrders(cashNow: number | null): Promise<RecordResult> {
  const fills = strategyFills(await getFilledOptionOrders(new Date(`${LOG_START}T00:00:00-05:00`), new Date()));
  const hintSnaps = fills.length ? await db.getAll(...fills.map((f) => ORDER_HINTS.doc(f.orderId))) : [];
  const hints = new Map(hintSnaps.filter((s) => s.exists).map((s) => [s.id, s.data()!]));

  const result: RecordResult = { opened: 0, closed: 0, matched: 0, ignored: 0, lines: [] };
  for (const f of fills) {
    const cash = Date.now() - Date.parse(f.fillTime) < FRESH_FILL_MS ? cashNow : null;
    const hint = hints.get(f.orderId);
    const { outcome, events } = f.instruction === 'BUY_TO_OPEN'
      ? await recordOpen(f, cash, hint)
      : await recordClose(f, cash, hint?.exitType);
    if (outcome === 'recorded') result[f.instruction === 'BUY_TO_OPEN' ? 'opened' : 'closed']++;
    else if (outcome === 'matched') result.matched++;
    else if (outcome === 'ignored') result.ignored++;
    for (const e of events) {
      await logEvent(e);
      if (e.type === 'trade-closed') result.lines.push(e.text);
    }
  }
  if (result.opened || result.closed || result.matched) logger.info('Recorded Schwab orders', result);
  return result;
}
