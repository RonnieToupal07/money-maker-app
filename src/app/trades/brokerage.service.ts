import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { getApps, initializeApp } from 'firebase/app';
import { Timestamp, doc, getFirestore, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase.config';

/** Mirrors OptionPosition in functions/src/schwab/sync.ts. */
export interface SchwabOptionPosition {
  symbol: string;
  ticker: string;
  strike: number;
  exp: string;
  putCall: 'C' | 'P';
  description: string;
  quantity: number;
  averagePrice: number;
  marketValue: number;
  openProfitLoss: number;
  dayProfitLoss: number | null;
}

export interface SchwabAccount {
  accountType: string;
  cashAvailable: number;
  accountValue: number;
  positions: SchwabOptionPosition[];
  syncedAt: string | null;
  refreshExpiresAt: number | null; // ms; the connection needs reconnecting after this
}

interface SyncResult {
  recorded: { opened: number; closed: number; matched: number; ignored: number };
}

/** Latest Schwab balances (brokerage/schwab, written by the functions) and the Sync and Reconnect buttons. */
@Injectable({ providedIn: 'root' })
export class BrokerageService {
  readonly account = signal<SchwabAccount | null>(null);
  readonly syncing = signal(false);
  readonly reconnecting = signal(false);
  readonly message = signal<string | null>(null);

  private readonly document = inject(DOCUMENT);
  private readonly app = getApps()[0] ?? initializeApp(firebaseConfig);
  private readonly syncSchwab = httpsCallable<void, SyncResult>(getFunctions(this.app), 'syncSchwab', { timeout: 120_000 });
  private readonly schwabConnectUrl = httpsCallable<void, { url: string }>(getFunctions(this.app), 'schwabConnectUrl');

  constructor() {
    if (!firebaseConfig.projectId) return;
    const unsubscribe = onSnapshot(
      doc(getFirestore(this.app), 'brokerage', 'schwab'),
      (snap) => {
        const d = snap.data();
        this.account.set(
          d
            ? {
                accountType: String(d['accountType'] ?? ''),
                cashAvailable: Number(d['cashAvailable'] ?? 0),
                accountValue: Number(d['accountValue'] ?? 0),
                positions: Array.isArray(d['positions']) ? (d['positions'] as SchwabOptionPosition[]) : [],
                syncedAt: d['syncedAt'] instanceof Timestamp ? d['syncedAt'].toDate().toISOString() : null,
                refreshExpiresAt: d['refreshExpiresAt'] != null ? Number(d['refreshExpiresAt']) : null,
              }
            : null,
        );
      },
      () => this.account.set(null),
    );
    inject(DestroyRef).onDestroy(unsubscribe);
  }

  async sync(): Promise<void> {
    if (this.syncing()) return;
    this.syncing.set(true);
    this.message.set(null);
    try {
      const { recorded: r } = (await this.syncSchwab()).data;
      const changes = r.opened + r.closed + r.matched;
      this.message.set(
        changes
          ? `Logged ${r.opened} BTO, ${r.closed} STC, matched ${r.matched} entered here`
          : 'Synced - no new BTO/STC fills',
      );
    } catch (err) {
      this.message.set(`Schwab sync failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.syncing.set(false);
    }
  }

  /** Sends this tab to the Schwab login; Schwab returns to the schwabAuth function when done. */
  async reconnect(): Promise<void> {
    if (this.reconnecting()) return;
    this.reconnecting.set(true);
    this.message.set(null);
    try {
      this.document.location.assign((await this.schwabConnectUrl()).data.url);
    } catch (err) {
      this.message.set(`Schwab reconnect failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.reconnecting.set(false);
    }
  }
}
