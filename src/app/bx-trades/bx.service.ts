import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { getApps, initializeApp } from 'firebase/app';
import { Timestamp, collection, doc, getFirestore, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase.config';

// Keep in sync with functions/src/bx.ts. This strategy's collections are separate from the MACD
// strategy's; the app only reads them, and every change goes through those functions.
const SUGGESTIONS = 'bxSuggestions';
const TRADES = 'bxTrades';
const SCANS = 'bxScans';
const EVENTS = 'bxEvents';

export type BxDirection = 'sell_put' | 'sell_call';

export interface BxSuggestion {
  id: string;
  kind: 'open' | 'close';
  /** 'withdrawn': a take profit that fell back under its target; a later check can flag it again. */
  status: 'pending' | 'placing' | 'working' | 'filled' | 'partial' | 'expired' | 'unknown' | 'withdrawn';
  date: string;
  ticker: string;
  direction: BxDirection;
  strike: number;
  expiration: string;
  contracts: number | null;
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
  filledQuantity?: number;
  avgFillPrice?: number;
  lastError?: string;
}

export interface BxTrade {
  id: string;
  status: 'open' | 'closed';
  ticker: string;
  direction: BxDirection;
  strike: number;
  expiration: string;
  contracts: number;
  openedContracts: number;
  entryDate: string;
  entryPrice: number;
  /** Schwab's option symbol, matched against the account's positions. */
  symbol: string;
  buyingPower: number;
  realizedPnl: number;
  exitDate?: string;
  exitPrice?: number;
  exitReason?: string;
  missingAtSchwab?: boolean;
  note?: string;
}

export interface BxAccount {
  accountType: string;
  accountValue: number;
  cashAvailable: number;
  availableFunds: number | null;
  /** Option positions as of the last sync; marketValue is negative for short contracts. */
  positions: { symbol: string; shortQuantity: number; marketValue: number; maintenanceRequirement?: number | null }[];
  syncedAt: string | null;
}

/** Keep in sync with MarginDetail in functions/src/bx.ts. Amounts are per contract unless named total. */
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
  app: { priceLeg: { pct: number; amount: number }; strikeLeg: { pct: number; amount: number }; perContract: number; total: number } | null;
  standard: { priceLeg: number; floorLeg: number; perContract: number; total: number } | null;
  atEntry: number;
  schwab: number | null;
  schwabQuantity: number;
  fetchedAt: string;
  notes: string[];
}

export interface BxCheck {
  ticker: string;
  direction: BxDirection;
  peakScore: number;
  spot: number;
  /** Entry score (puts need above 850, calls above -250); null if it was blocked before scoring. */
  score?: number | null;
  blocked: string | null;
}

export interface BxScanDoc {
  day: string;
  spyRegime: string | null;
  checks: BxCheck[];
  failed: string[];
}

export interface BxEvent {
  id: string;
  text: string;
  at: string | null;
}

export interface BxScanResult extends BxScanDoc {
  published: boolean;
  exits: { ticker: string; tradeId: string; reason: string | null; note: string; mark: number | null }[];
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Live view of the strategy's collections, and the calls that place and cancel its orders. */
@Injectable({ providedIn: 'root' })
export class BxService {
  readonly suggestions = signal<BxSuggestion[]>([]);
  readonly trades = signal<BxTrade[]>([]);
  readonly account = signal<BxAccount | null>(null);
  readonly lastScan = signal<BxScanDoc | null>(null);
  readonly events = signal<BxEvent[]>([]);
  readonly loadError = signal<string | null>(null);

  private readonly app = getApps()[0] ?? initializeApp(firebaseConfig);
  private readonly functions = getFunctions(this.app);
  private readonly placeOrderCall = httpsCallable<{ suggestionId: string }, { limitPrice: number; quantity: number }>(this.functions, 'bxPlaceOrder', { timeout: 60_000 });
  private readonly closeTradeCall = httpsCallable<{ tradeId: string }, { limitPrice: number; quantity: number }>(this.functions, 'bxCloseTrade', { timeout: 60_000 });
  private readonly cancelOrderCall = httpsCallable<{ suggestionId: string }, unknown>(this.functions, 'bxCancelOrder', { timeout: 60_000 });
  private readonly marginDetailCall = httpsCallable<{ tradeId: string }, MarginDetail>(this.functions, 'bxMarginDetail', { timeout: 60_000 });
  private readonly syncCall =httpsCallable<void, { lines: string[] }>(this.functions, 'bxSync', { timeout: 120_000 });
  private readonly scanCall = httpsCallable<void, BxScanResult>(this.functions, 'bxScanNow', { timeout: 540_000 });

  constructor() {
    if (!firebaseConfig.projectId) return;
    const db = getFirestore(this.app);
    const failed = (err: Error) => this.loadError.set(`Can't read this strategy's data: ${err.message}`);
    const stops = [
      onSnapshot(query(collection(db, SUGGESTIONS), orderBy('date', 'desc'), limit(100)), (snap) => {
        this.suggestions.set(snap.docs.map((d) => ({ ...(d.data() as Omit<BxSuggestion, 'id'>), id: d.id })));
      }, failed),
      onSnapshot(collection(db, TRADES), (snap) => {
        this.trades.set(snap.docs.map((d) => ({ ...(d.data() as Omit<BxTrade, 'id'>), id: d.id })));
      }, failed),
      onSnapshot(doc(db, 'bxAccount', 'schwab'), (snap) => {
        const d = snap.data();
        this.account.set(d ? {
          accountType: String(d['accountType'] ?? ''),
          accountValue: Number(d['accountValue'] ?? 0),
          cashAvailable: Number(d['cashAvailable'] ?? 0),
          availableFunds: d['availableFunds'] != null ? Number(d['availableFunds']) : null,
          positions: Array.isArray(d['positions']) ? (d['positions'] as BxAccount['positions']) : [],
          syncedAt: d['syncedAt'] instanceof Timestamp ? d['syncedAt'].toDate().toISOString() : null,
        } : null);
      }, failed),
      onSnapshot(query(collection(db, SCANS), orderBy('day', 'desc'), limit(1)), (snap) => {
        this.lastScan.set((snap.docs[0]?.data() as BxScanDoc | undefined) ?? null);
      }, failed),
      onSnapshot(query(collection(db, EVENTS), orderBy('at', 'desc'), limit(30)), (snap) => {
        this.events.set(snap.docs.map((d) => {
          const at = d.get('at');
          return { id: d.id, text: String(d.get('text') ?? ''), at: at instanceof Timestamp ? at.toDate().toISOString() : null };
        }));
      }, failed),
    ];
    inject(DestroyRef).onDestroy(() => stops.forEach((stop) => stop()));
  }

  /** Each resolves to a line for the page, or rejects with the reason it didn't happen. */
  async placeOrder(suggestionId: string): Promise<string> {
    const { limitPrice, quantity } = (await this.placeOrderCall({ suggestionId })).data;
    return `Order placed: ${quantity} at limit $${limitPrice.toFixed(2)}`;
  }

  async closeTrade(tradeId: string): Promise<string> {
    const { limitPrice, quantity } = (await this.closeTradeCall({ tradeId })).data;
    return `Close order placed: ${quantity} at limit $${limitPrice.toFixed(2)}`;
  }

  async cancelOrder(suggestionId: string): Promise<string> {
    await this.cancelOrderCall({ suggestionId });
    return 'Order canceled';
  }

  /** Live margin breakdown for one open trade, with Schwab's own requirement for the position. */
  async marginDetail(tradeId: string): Promise<MarginDetail> {
    return (await this.marginDetailCall({ tradeId })).data;
  }

  async sync(): Promise<string> {
    const { lines } = (await this.syncCall()).data;
    return lines.length ? lines.join(' · ') : 'Synced - nothing new';
  }

  async scan(): Promise<BxScanResult> {
    return (await this.scanCall()).data;
  }

  readonly errorText = errorText;
}
