import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { getApps, initializeApp } from 'firebase/app';
import {
  Firestore,
  Timestamp,
  addDoc,
  collection,
  doc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { CASH_UPDATES_COLLECTION, LOG_START, STARTING_ACCOUNT_VALUE, TRADES_COLLECTION, YEAR, firebaseConfig } from '../firebase.config';
import { CashUpdate, Trade, cashUpdateFromDoc, currentCash, fromDoc } from './trade.model';

export interface NewTrade {
  ticker: string;
  strike: number;
  exp: string;
  contracts: number;
  entryPrice: number;
  openedAt: Date;
  cashAfterOpen: number;
}

export interface TradeClose {
  exitPrice: number;
  closedAt: Date;
  exitType: string;
  cashAfterClose: number;
}

// Midnight CT on LOG_START, as an ISO string to compare with Trade.openedAt.
const logStart = new Date(`${LOG_START}T00:00:00-05:00`).toISOString();

/** Live view of the Firestore `trades` collection, limited to trades opened in YEAR from LOG_START on. */
@Injectable({ providedIn: 'root' })
export class TradesService {
  readonly trades = signal<Trade[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly configured = !!firebaseConfig.projectId;
  readonly cashUpdates = signal<CashUpdate[]>([]);
  /** Free cash right now, from the latest recorded cash amount plus any unrecorded trades. */
  readonly cash = computed(() => currentCash(this.trades(), STARTING_ACCOUNT_VALUE, this.cashUpdates()));

  private readonly db: Firestore | null = this.configured
    ? getFirestore(getApps()[0] ?? initializeApp(firebaseConfig))
    : null;

  constructor() {
    if (!this.db) {
      this.loading.set(false);
      this.error.set('Firebase is not configured yet — fill in src/app/firebase.config.ts.');
      return;
    }
    const unsubscribe = onSnapshot(
      collection(this.db, TRADES_COLLECTION),
      (snap) => {
        const trades = snap.docs
          .map((doc) => fromDoc(doc.id, doc.data()))
          .filter((t) => t.openedAt.startsWith(YEAR) && t.openedAt >= logStart)
          .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
        this.trades.set(trades);
        this.loading.set(false);
        this.error.set(null);
      },
      (err) => {
        this.loading.set(false);
        this.error.set(`Couldn't read trades: ${err.message}`);
      },
    );
    const unsubscribeCash = onSnapshot(
      collection(this.db, CASH_UPDATES_COLLECTION),
      (snap) => {
        this.cashUpdates.set(snap.docs.flatMap((doc) => cashUpdateFromDoc(doc.id, doc.data()) ?? []));
      },
      (err) => this.error.set(`Couldn't read cash updates: ${err.message}`),
    );
    inject(DestroyRef).onDestroy(() => {
      unsubscribe();
      unsubscribeCash();
    });
  }

  /** Sets free cash to `cash` as of now; later trades adjust from there. */
  async updateCash(cash: number): Promise<void> {
    if (!this.db) throw new Error('Firebase is not configured yet.');
    await addDoc(collection(this.db, CASH_UPDATES_COLLECTION), {
      cash,
      at: Timestamp.now(),
      createdAt: serverTimestamp(),
    });
  }

  /** Records a newly opened trade; the snapshot listener picks it up. */
  async addTrade(trade: NewTrade): Promise<void> {
    if (!this.db) throw new Error('Firebase is not configured yet.');
    await addDoc(collection(this.db, TRADES_COLLECTION), {
      ...trade,
      ticker: trade.ticker.trim().toUpperCase(),
      openedAt: Timestamp.fromDate(trade.openedAt),
      closedAt: null,
      exitPrice: null,
      exitType: '',
      pnl: null,
      cashAfterClose: null,
      createdAt: serverTimestamp(),
    });
  }

  /** Closes an open trade. pnl is written here too; computeTradePnl then has nothing to change. */
  async closeTrade(trade: Trade, close: TradeClose): Promise<void> {
    if (!this.db) throw new Error('Firebase is not configured yet.');
    const pnl = Math.round((close.exitPrice - trade.entryPrice) * trade.contracts * 100 * 100) / 100;
    await updateDoc(doc(this.db, TRADES_COLLECTION, trade.id), {
      exitPrice: close.exitPrice,
      closedAt: Timestamp.fromDate(close.closedAt),
      exitType: close.exitType.trim(),
      cashAfterClose: close.cashAfterClose,
      pnl,
    });
  }
}
