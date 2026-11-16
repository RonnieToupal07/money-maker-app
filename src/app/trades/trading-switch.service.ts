import { Injectable, signal } from '@angular/core';
import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase.config';

/** Mirrors TradingSwitchState in functions/src/entries.ts. */
export interface TradingSwitchState {
  enabled: boolean;
  /** Whether SCHWAB_TRADING=live; when it isn't, nothing trades whatever the switch says. */
  envLive: boolean;
}

/** The dashboard's Auto-trading switch (settings/trading, read and written by the functions). */
@Injectable({ providedIn: 'root' })
export class TradingSwitchService {
  readonly state = signal<TradingSwitchState | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  private readonly functions = getFunctions(getApps()[0] ?? initializeApp(firebaseConfig));
  private readonly getCall = httpsCallable<void, TradingSwitchState>(this.functions, 'getAutoTrading');
  private readonly setCall = httpsCallable<{ enabled: boolean }, TradingSwitchState>(this.functions, 'setAutoTrading');

  constructor() {
    if (firebaseConfig.projectId) void this.load();
  }

  async load(): Promise<void> {
    try {
      this.state.set((await this.getCall()).data);
    } catch (err) {
      this.error.set(`Can't read the auto-trading switch: ${err instanceof Error ? err.message : err}`);
    }
  }

  async set(enabled: boolean): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      this.state.set((await this.setCall({ enabled })).data);
    } catch (err) {
      this.error.set(`Couldn't switch auto-trading ${enabled ? 'on' : 'off'}: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.saving.set(false);
    }
  }
}
