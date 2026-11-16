import { Injectable, signal } from '@angular/core';
import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase.config';

// Mirrors EntrySignal / EntryCheck / ExitCheck / ScanResult in functions/src/strategy/macdexpLive.ts.
export interface EntrySignal {
  ticker: string;
  candleTime: string;
  price: number;
  troughValue: number;
  entryRsi: number;
  entrySlope: number;
  expiration: string;
  strike: number | null;
  otmPct: number | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  lastTradePrice: number | null;
  /** The live bid/ask mid: the entry order's first limit. null = no two-sided quote yet. */
  entryPrice: number | null;
  boostRule: number;
  capPct: number;
  suggestedContracts: number | null;
  estimatedCost: number | null;
  skipReason: string | null;
}

export interface EntryCheck {
  ticker: string;
  status: 'enter' | 'skip' | 'no-entry' | 'failed';
  candleTime: string | null;
  price: number | null;
  macd: number | null;
  macdPrev: number | null;
  macdPrev2: number | null;
  armed: boolean;
  rsi: number | null;
  slope: number | null;
  reasons: string[];
  signal: EntrySignal | null;
}

export interface ExitCheck {
  tradeId: string;
  ticker: string;
  strike: number;
  expiration: string;
  contracts: number;
  entryPrice: number;
  openedAt: string;
  optionTicker: string;
  candleTime: string | null;
  price: number | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  lastTradePrice: number | null;
  optionPrice: number | null;
  unrealizedPnl: number | null;
  takeProfitPrice: number;
  barsHeld: number | null;
  holdBars: number;
  status: 'exit' | 'hold' | 'failed';
  exitType: 'take-profit' | 'forced' | 'expiration' | null;
  reasons: string[];
}

export interface ScanResult {
  asOf: string;
  scanned: number;
  candleTime: string | null;
  failed: string[];
  cashAvailable: number;
  openCount: number;
  maxConcurrentOpen: number;
  signals: EntrySignal[];
  entries: EntryCheck[];
  exits: ExitCheck[];
}

/** Runs the server's entry + exit check (the same rules the SMS alerts use) and keeps the last result. */
@Injectable({ providedIn: 'root' })
export class ScanService {
  readonly running = signal(false);
  readonly result = signal<ScanResult | null>(null);
  readonly error = signal<string | null>(null);

  // The scan reads ~180 tickers' history, so allow longer than the SDK's 70s default.
  private readonly checkForEntries = httpsCallable<void, ScanResult>(
    getFunctions(getApps()[0] ?? initializeApp(firebaseConfig)),
    'checkForEntries',
    { timeout: 300_000 },
  );

  async run(): Promise<void> {
    if (this.running()) return;
    this.running.set(true);
    this.error.set(null);
    try {
      this.result.set((await this.checkForEntries()).data);
    } catch (err) {
      this.error.set(`Look For Trades failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running.set(false);
    }
  }
}
