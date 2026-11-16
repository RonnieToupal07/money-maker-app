import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { CtTimePipe, UsdPipe } from '../trades/format';
import { BxService, BxTrade, MarginDetail } from './bx.service';

/**
 * Opened from an open trade's Margin cell: asks Schwab for the position's live margin requirement and
 * works the app's formula out at today's stock and option prices, side by side.
 */
@Component({
  selector: 'app-margin-popover',
  imports: [UsdPipe, CtTimePipe],
  template: `
    <dialog #dialog aria-labelledby="margin-title" (click)="backdropClose($event)">
      @if (trade(); as t) {
        <h2 id="margin-title">Margin · {{ t.ticker }} {{ t.expiration }} {{ t.strike | usd }}{{ t.direction === 'sell_put' ? 'P' : 'C' }}</h2>
        <p class="summary">{{ t.contracts }} contract{{ t.contracts === 1 ? '' : 's' }} sold at {{ t.entryPrice | usd }}</p>

        @if (loading()) {
          <p class="note">Asking Schwab…</p>
        } @else if (error(); as e) {
          <p class="error" role="alert">{{ e }}</p>
        } @else if (detail(); as d) {
          <div class="compare">
            <div class="box schwab">
              <span class="label">Schwab requirement</span>
              <span class="value">{{ d.schwab != null ? (d.schwab | usd) : '—' }}</span>
              <span class="sub">live, from the position · {{ d.fetchedAt | ct }}</span>
            </div>
            <div class="box">
              <span class="label">App estimate now</span>
              <span class="value">{{ d.app ? (d.app.total | usd) : '—' }}</span>
              <span class="sub">reserved at entry {{ d.atEntry | usd }}</span>
            </div>
          </div>

          @if (d.app && d.standard && d.spot != null && d.mark != null && d.otm != null) {
            <h3>Inputs</h3>
            <dl class="lines">
              <dt>Stock price</dt><dd>{{ d.spot | usd }}</dd>
              <dt>Option price (premium)</dt><dd>{{ d.mark | usd }}</dd>
              <dt>Out of the money by</dt><dd>{{ d.otm | usd }}</dd>
              <dt>Implied volatility</dt><dd>{{ d.iv != null ? pct(d.iv) : 'unknown' }}{{ d.housePct ? ' → ' + pct(d.housePct) + ' house rate' : '' }}</dd>
            </dl>

            <h3>App's rule (per contract, larger of)</h3>
            <dl class="lines">
              <dt [class.win]="d.app.priceLeg.amount >= d.app.strikeLeg.amount">
                ({{ pct(d.app.priceLeg.pct) }} × {{ d.spot | usd }} − {{ d.otm | usd }} + {{ d.mark | usd }}) × 100
              </dt>
              <dd [class.win]="d.app.priceLeg.amount >= d.app.strikeLeg.amount">{{ d.app.priceLeg.amount | usd }}</dd>
              <dt [class.win]="d.app.strikeLeg.amount > d.app.priceLeg.amount">{{ pct(d.app.strikeLeg.pct) }} × {{ d.strike | usd }} strike × 100</dt>
              <dd [class.win]="d.app.strikeLeg.amount > d.app.priceLeg.amount">{{ d.app.strikeLeg.amount | usd }}</dd>
              <dt class="total">× {{ d.contracts }} contract{{ d.contracts === 1 ? '' : 's' }}</dt>
              <dd class="total">{{ d.app.total | usd }}</dd>
            </dl>

            <h3>Industry minimum (per contract, larger of)</h3>
            <dl class="lines">
              <dt [class.win]="d.standard.priceLeg >= d.standard.floorLeg">(20% × {{ d.spot | usd }} − {{ d.otm | usd }} + {{ d.mark | usd }}) × 100</dt>
              <dd [class.win]="d.standard.priceLeg >= d.standard.floorLeg">{{ d.standard.priceLeg | usd }}</dd>
              <dt [class.win]="d.standard.floorLeg > d.standard.priceLeg">
                (10% × {{ (d.direction === 'sell_put' ? d.strike : d.spot) | usd }} {{ d.direction === 'sell_put' ? 'strike' : 'stock' }} + {{ d.mark | usd }}) × 100
              </dt>
              <dd [class.win]="d.standard.floorLeg > d.standard.priceLeg">{{ d.standard.floorLeg | usd }}</dd>
              <dt class="total">× {{ d.contracts }} contract{{ d.contracts === 1 ? '' : 's' }}</dt>
              <dd class="total">{{ d.standard.total | usd }}</dd>
            </dl>
            <p class="note">
              Schwab starts from the industry minimum and can add its own house requirement on volatile or concentrated positions,
              so its number can land anywhere between the two.
            </p>
          }
          @for (n of d.notes; track n) {
            <p class="note warn">{{ n }}</p>
          }
        }

        <div class="actions">
          <button class="btn" type="button" (click)="load(t)" [disabled]="loading()">Refresh</button>
          <button class="btn primary" type="button" (click)="dialog.close()">Done</button>
        </div>
      }
    </dialog>
  `,
  styles: `
    dialog {
      width: min(560px, calc(100vw - 32px));
      padding: 20px;
      border: 1px solid var(--hairline);
      border-radius: 12px;
      background: var(--surface);
      color: var(--ink);
    }
    dialog::backdrop { background: rgb(0 0 0 / 0.35); }
    h2 { font-family: var(--font-display); font-size: 18px; font-weight: 600; margin: 0 0 4px; }
    h3 { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); margin: 16px 0 6px; font-weight: 600; }
    .summary { font-family: var(--font-mono); font-size: 12.5px; color: var(--ink-muted); margin: 0 0 14px; }
    .compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .box { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border: 1px solid var(--hairline); border-radius: 9px; min-width: 0; }
    .box.schwab { border-color: color-mix(in srgb, var(--accent) 45%, var(--hairline)); }
    .label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); }
    .value { font-family: var(--font-mono); font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .sub { font-family: var(--font-mono); font-size: 11px; color: var(--ink-muted); }
    .lines { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 0; font-size: 12.5px; }
    .lines dt { font-family: var(--font-mono); color: var(--ink-muted); overflow-wrap: anywhere; }
    .lines dd { margin: 0; text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .lines .win { color: var(--ink); font-weight: 600; }
    .lines .total { border-top: 1px solid var(--hairline); padding-top: 4px; color: var(--ink); font-weight: 600; }
    .note { font-size: 12px; color: var(--ink-muted); margin: 10px 0 0; }
    .note.warn { color: var(--loss); }
    .error { color: var(--loss); background: var(--loss-bg); font-size: 12.5px; padding: 8px 10px; border-radius: 7px; margin: 12px 0 0; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    @media (max-width: 480px) { .compare { grid-template-columns: 1fr; } }
  `,
})
export class MarginPopover {
  private readonly bx = inject(BxService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly trade = signal<BxTrade | null>(null);
  protected readonly detail = signal<MarginDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  open(trade: BxTrade): void {
    this.trade.set(trade);
    this.dialog().nativeElement.showModal();
    void this.load(trade);
  }

  protected async load(trade: BxTrade): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.detail.set(null);
    try {
      this.detail.set(await this.bx.marginDetail(trade.id));
    } catch (err) {
      this.error.set(this.bx.errorText(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected pct(fraction: number): string {
    return `${Math.round(fraction * 100)}%`;
  }

  /** A click on the dimmed area outside the box closes it. */
  protected backdropClose(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.dialog().nativeElement.close();
  }
}
