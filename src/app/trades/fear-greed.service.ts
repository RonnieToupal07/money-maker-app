import { Injectable, signal } from '@angular/core';
import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase.config';

/** Mirrors getFearGreed in functions/src/entries.ts. */
export interface FearGreedState {
  /** The trading day whose close today's signals need. */
  needed: string;
  /** The reading today's signals use: the latest from before today, if within a week. */
  used: { date: string; value: number } | null;
  recent: { date: string; value: number }[];
}

/** CNN Fear & Greed readings for the entry filter, entered by hand (CNN blocks automated requests). */
@Injectable({ providedIn: 'root' })
export class FearGreedService {
  readonly state = signal<FearGreedState | null>(null);

  private readonly functions = getFunctions(getApps()[0] ?? initializeApp(firebaseConfig));
  private readonly getFearGreed = httpsCallable<void, FearGreedState>(this.functions, 'getFearGreed');
  private readonly setFearGreed = httpsCallable<{ date: string; value: number }, unknown>(this.functions, 'setFearGreed');

  constructor() {
    if (firebaseConfig.projectId) void this.load();
  }

  async load(): Promise<void> {
    try {
      this.state.set((await this.getFearGreed()).data);
    } catch {
      this.state.set(null);
    }
  }

  async save(date: string, value: number): Promise<void> {
    await this.setFearGreed({ date, value });
    await this.load();
  }
}
