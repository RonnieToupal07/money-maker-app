import { Component, computed, inject, signal } from '@angular/core';
import { CtTimePipe, PctPipe, UsdPipe } from '../trades/format';
import { BxCheck, BxDirection, BxScanResult, BxService, BxSuggestion, BxTrade } from './bx.service';
import { MarginPopover } from './margin-popover';

const REASONS: Record<string, string> = {
  take_profit: 'Take profit',
  stop_loss: 'Stop loss',
  dte_exit: 'Days to expiry',
  expiration_risk: 'Expiring',
  manual: 'By hand',
};

/** The Open / Close action waiting on its second click. */
type Confirming = { kind: 'suggestion'; id: string; text: string } | { kind: 'trade'; id: string; text: string };

/** Today's date in New York, which is what suggestions are dated by. */
const etDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

@Component({
  selector: 'app-bx-trades',
  imports: [UsdPipe, PctPipe, CtTimePipe, MarginPopover],
  templateUrl: './bx-trades.html',
  styleUrl: './bx-trades.scss',
})
export class BxTrades {
  private readonly bx = inject(BxService);

  protected readonly account = this.bx.account;
  protected readonly lastScan = this.bx.lastScan;
  protected readonly events = this.bx.events;
  protected readonly loadError = this.bx.loadError;

  protected readonly busy = signal(false);
  protected readonly scanning = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal<Confirming | null>(null);
  protected readonly preview = signal<BxScanResult | null>(null);

  private readonly today = computed(() => this.bx.suggestions().filter((s) => s.date === etDate()));
  protected readonly opens = computed(() => this.today().filter((s) => s.kind === 'open'));
  protected readonly closes = computed(() => this.today().filter((s) => s.kind === 'close'));
  protected readonly needsChecking = computed(() => this.bx.suggestions().filter((s) => s.status === 'unknown'));
  protected readonly openTrades = computed(() =>
    this.bx.trades().filter((t) => t.status === 'open').sort((a, b) => a.expiration.localeCompare(b.expiration)),
  );
  protected readonly closedTrades = computed(() =>
    this.bx.trades().filter((t) => t.status === 'closed').sort((a, b) => (b.exitDate ?? '').localeCompare(a.exitDate ?? '')),
  );
  /** Schwab's requirement per position where the last sync had one, else what the app reserved at entry. */
  protected readonly marginInUse = computed(() => this.openTrades().reduce((sum, t) => sum + (this.schwabMargin(t) ?? t.buyingPower), 0));
  protected readonly realized = computed(() => this.bx.trades().reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0));
  protected readonly blocked = computed<BxCheck[]>(() => (this.preview() ?? this.lastScan())?.checks.filter((c) => c.blocked) ?? []);
  protected readonly previewEntries = computed<BxCheck[]>(() => {
    const p = this.preview();
    return p && !p.published ? p.checks.filter((c) => !c.blocked) : [];
  });

  /** A close already in flight or done today for this trade, if any. */
  protected closeFor(trade: BxTrade): BxSuggestion | undefined {
    return this.closes().find((s) => s.tradeId === trade.id);
  }

  /**
   * Share of the premium kept so far, from the mark at the last Schwab sync - the same measure the
   * take-profit and stop-loss exits use. Null when Schwab shows no short position for the trade.
   */
  protected gainPct(trade: BxTrade): number | null {
    const mark = this.markFor(trade);
    return mark != null && trade.entryPrice ? ((trade.entryPrice - mark) / trade.entryPrice) * 100 : null;
  }

  /** The option's price per share at the last Schwab sync; null when Schwab shows no short position. */
  protected markFor(trade: BxTrade): number | null {
    const p = this.positionFor(trade);
    return p ? Math.abs(p.marketValue) / p.shortQuantity / 100 : null;
  }

  /** Schwab's own margin requirement for the position at the last sync, when it reports one. */
  protected schwabMargin(trade: BxTrade): number | null {
    return this.positionFor(trade)?.maintenanceRequirement ?? null;
  }

  private positionFor(trade: BxTrade) {
    return this.account()?.positions.find((x) => x.symbol === trade.symbol && x.shortQuantity > 0);
  }

  protected sideLabel(direction: BxDirection): string {
    return direction === 'sell_put' ? 'P' : 'C';
  }

  protected scoreText(c: BxCheck): string {
    return c.score != null ? c.score.toFixed(0) : '—';
  }

  protected reasonLabel(reason: string | undefined): string {
    return reason ? REASONS[reason] ?? reason : '—';
  }

  protected statusLabel(s: BxSuggestion): string {
    switch (s.status) {
      case 'pending': return 'Suggested';
      case 'placing': return 'Sending…';
      case 'working': return `Working @ $${s.limitPrice?.toFixed(2)}`;
      case 'filled': return `Filled @ $${s.avgFillPrice?.toFixed(2)}`;
      case 'partial': return `Part filled: ${s.filledQuantity} of ${s.quantity}`;
      case 'expired': return 'Expired';
      case 'withdrawn': return 'Withdrawn · under target';
      case 'unknown': return 'Check Schwab';
    }
  }

  protected askConfirm(s: BxSuggestion): void {
    const verb = s.kind === 'open' ? 'SELL to open' : 'BUY to close';
    const price = s.proposedPrice != null ? `about $${s.proposedPrice.toFixed(2)}` : 'the live mid';
    const margin = s.kind === 'open' && s.perContractBp && s.contracts
      ? ` Ties up about $${Math.round(s.perContractBp * s.contracts).toLocaleString('en-US')} of margin.`
      : '';
    this.confirming.set({
      kind: 'suggestion',
      id: s.id,
      text: `${verb} ${s.contracts} ${s.ticker} ${s.expiration} $${s.strike}${this.sideLabel(s.direction)} at the live mid (${price}), as a DAY limit order.${margin}`,
    });
  }

  protected askConfirmClose(t: BxTrade): void {
    this.confirming.set({
      kind: 'trade',
      id: t.id,
      text: `BUY to close ${t.contracts} ${t.ticker} ${t.expiration} $${t.strike}${this.sideLabel(t.direction)} at the live mid, as a DAY limit order.`,
    });
  }

  protected async confirm(): Promise<void> {
    const c = this.confirming();
    if (!c) return;
    this.confirming.set(null);
    await this.run(() => (c.kind === 'suggestion' ? this.bx.placeOrder(c.id) : this.bx.closeTrade(c.id)));
  }

  protected cancelOrder(s: BxSuggestion): Promise<void> {
    return this.run(() => this.bx.cancelOrder(s.id));
  }

  protected sync(): Promise<void> {
    return this.run(() => this.bx.sync());
  }

  protected async scan(): Promise<void> {
    if (this.scanning()) return;
    this.scanning.set(true);
    this.error.set(null);
    this.message.set(null);
    try {
      const result = await this.bx.scan();
      this.preview.set(result);
      this.message.set(result.published
        ? 'Scan done - new suggestions are below and were texted.'
        : 'Preview only: outside 2:25-3:00 PM CT nothing is suggested or texted, since a signal can vanish by the close.');
    } catch (err) {
      this.error.set(this.bx.errorText(err));
    } finally {
      this.scanning.set(false);
    }
  }

  private async run(action: () => Promise<string>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);
    try {
      this.message.set(await action());
    } catch (err) {
      this.error.set(this.bx.errorText(err));
    } finally {
      this.busy.set(false);
    }
  }
}
