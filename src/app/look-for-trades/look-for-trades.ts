import { Component, computed, inject, signal } from '@angular/core';
import { CloseTradeDialog } from '../dashboard/close-trade-dialog';
import { NewTradeDialog } from '../dashboard/new-trade-dialog';
import { CtTimePipe, UsdPipe } from '../trades/format';
import { EntryCheck, ExitCheck, ScanService } from '../trades/scan.service';
import { TradesService } from '../trades/trades.service';

type EntryFilter = 'all' | EntryCheck['status'];

const EXIT_LABELS: Record<NonNullable<ExitCheck['exitType']>, string> = {
  'take-profit': 'Take profit',
  forced: 'Forced',
  expiration: 'Expiration',
};

@Component({
  selector: 'app-look-for-trades',
  imports: [UsdPipe, CtTimePipe, CloseTradeDialog, NewTradeDialog],
  templateUrl: './look-for-trades.html',
  styleUrl: './look-for-trades.scss',
})
export class LookForTrades {
  private readonly scan = inject(ScanService);
  private readonly tradesService = inject(TradesService);

  protected readonly running = this.scan.running;
  protected readonly result = this.scan.result;
  protected readonly error = this.scan.error;
  protected readonly filter = signal<EntryFilter>('all');
  protected readonly search = signal('');
  protected readonly exitLabels = EXIT_LABELS;

  protected readonly counts = computed(() => {
    const entries = this.result()?.entries ?? [];
    const count = (s: EntryCheck['status']) => entries.filter((e) => e.status === s).length;
    return { all: entries.length, enter: count('enter'), skip: count('skip'), 'no-entry': count('no-entry'), failed: count('failed') };
  });

  protected readonly exitCount = computed(() => (this.result()?.exits ?? []).filter((e) => e.status === 'exit').length);

  /** Close time of the candle the scan judged (candles are stored by their open time). */
  protected readonly candleClose = computed(() => {
    const open = this.result()?.candleTime;
    return open ? new Date(Date.parse(open) + 30 * 60_000).toISOString() : null;
  });

  protected readonly entries = computed(() => {
    const filter = this.filter();
    const query = this.search().trim().toUpperCase();
    return (this.result()?.entries ?? []).filter(
      (e) => (filter === 'all' || e.status === filter) && (!query || e.ticker.includes(query)),
    );
  });

  protected readonly filters: { value: EntryFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'enter', label: 'Enter' },
    { value: 'skip', label: 'Skipped' },
    { value: 'no-entry', label: 'No entry' },
    { value: 'failed', label: 'Failed' },
  ];

  protected run(): void {
    void this.scan.run();
  }

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  /** The dashboard trade behind an exit check, if it's still open. */
  protected openTrade(exit: ExitCheck) {
    return this.tradesService.trades().find((t) => t.id === exit.tradeId && t.pnl == null);
  }

  protected closeTrade(dialog: CloseTradeDialog, exit: ExitCheck): void {
    const trade = this.openTrade(exit);
    if (!trade) return;
    const exitPrice = exit.exitType === 'expiration' && exit.price != null
      ? Math.max(exit.price - exit.strike, 0)
      : exit.optionPrice;
    dialog.open(trade, { exitPrice, exitType: exit.exitType ?? 'manual' });
  }

  /** Opens New Trade filled from the signal; entry price and cash are left for the actual fill. */
  protected addTrade(dialog: NewTradeDialog, entry: EntryCheck): void {
    const s = entry.signal;
    if (!s) return;
    dialog.open({ ticker: s.ticker, strike: s.strike, exp: s.expiration, contracts: s.suggestedContracts ?? 1 });
  }

  protected fmt(value: number | null, digits = 2): string {
    return value == null ? '—' : value.toFixed(digits);
  }
}
