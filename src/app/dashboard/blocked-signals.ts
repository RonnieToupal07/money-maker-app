import { Component, signal } from '@angular/core';
import { getApps, initializeApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from '../firebase.config';
import { CtTimePipe, UsdPipe } from '../trades/format';

/** Mirrors BlockedSignal in functions/src/entries.ts. */
interface BlockedSignal {
  candleTime: string | null;
  ticker: string;
  pass: string | null;
  price: number | null;
  reason: string;
  filters: Record<string, unknown> | null;
}

const DAYS = 7;

/**
 * MACD signals the strategy saw but didn't trade, from the liveEvents log: each candle's signal a
 * filter (Fear & Greed, VWAP, ADX, trend, IV rank, %K, RVOL, candle time) or a position rule
 * (already holding, max open, cash) blocked, with the reason.
 */
@Component({
  selector: 'app-blocked-signals',
  imports: [CtTimePipe, UsdPipe],
  template: `
    <div class="panel-head">
      <h2>Signals Blocked <span class="since">last {{ days }} days</span></h2>
      <div class="head-actions">
        <button class="btn" type="button" (click)="load()" [disabled]="loading()">{{ loading() ? 'Loading…' : 'Refresh' }}</button>
      </div>
    </div>
    @if (error(); as e) {
      <div class="empty-note loss">{{ e }}</div>
    } @else if (rows() === null) {
      <div class="empty-note">Loading…</div>
    } @else if (!rows()!.length) {
      <div class="empty-note">No MACD signals were blocked in the last {{ days }} days.</div>
    } @else {
      <div class="table-scroll">
        <table class="log">
          <thead>
            <tr>
              <th>Candle</th>
              <th>Ticker</th>
              <th>Price</th>
              <th title="Judged 5 minutes before the candle's close (pre-close) or at it (close)">Pass</th>
              <th>Why Not Traded</th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track $index) {
              <tr>
                <td>{{ r.candleTime | ct }}</td>
                <td>{{ r.ticker }}</td>
                <td>{{ r.price | usd }}</td>
                <td>{{ r.pass ?? '—' }}</td>
                <td class="reasons">{{ r.reason }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styles: `
    td.reasons { white-space: normal; min-width: 280px; }
    .since { font-family: var(--font-mono); font-size: 11.5px; font-weight: 400; color: var(--ink-muted); margin-left: 6px; }
  `,
})
export class BlockedSignals {
  protected readonly days = DAYS;
  protected readonly rows = signal<BlockedSignal[] | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly call = httpsCallable<{ days: number }, BlockedSignal[]>(
    getFunctions(getApps()[0] ?? initializeApp(firebaseConfig)),
    'getBlockedSignals',
    { timeout: 60_000 },
  );

  constructor() {
    if (firebaseConfig.projectId) void this.load();
  }

  protected async load(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      this.rows.set((await this.call({ days: DAYS })).data);
    } catch (err) {
      this.error.set(`Couldn't load blocked signals: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading.set(false);
    }
  }
}
