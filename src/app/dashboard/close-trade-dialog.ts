import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Trade } from '../trades/trade.model';
import { TradesService } from '../trades/trades.service';
import { UsdPipe } from '../trades/format';

/** Value for a datetime-local input, in the browser's local time. */
function localDateTime(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** Dialog for closing an open trade; the dashboard calls open(trade) from the row's Close button. */
@Component({
  selector: 'app-close-trade-dialog',
  imports: [ReactiveFormsModule, UsdPipe],
  template: `
    <dialog #dialog (close)="reset()" aria-labelledby="close-trade-title">
      @if (trade(); as t) {
        <form [formGroup]="form" (ngSubmit)="save(t)">
          <h2 id="close-trade-title">Close {{ t.ticker }} {{ t.strike | usd }} · {{ t.exp }}</h2>
          <p class="summary">{{ t.contracts }} contract{{ t.contracts === 1 ? '' : 's' }} @ {{ t.entryPrice | usd }}</p>
          <div class="fields">
            <label>
              <span>Exit price / contract</span>
              <input type="number" step="0.01" min="0" formControlName="exitPrice" placeholder="30.00" />
            </label>
            <label>
              <span>Closed</span>
              <input type="datetime-local" formControlName="closedAt" />
            </label>
            <label>
              <span>Exit type</span>
              <input formControlName="exitType" autocomplete="off" placeholder="manual" />
            </label>
            <label>
              <span>Cash after close</span>
              <input type="number" step="0.01" formControlName="cashAfterClose" />
            </label>
          </div>

          <p class="cost">
            Proceeds: <strong>{{ proceeds() | usd }}</strong> · P&amp;L:
            <strong [class.profit]="pnl() > 0" [class.loss]="pnl() < 0">{{ pnl() | usd: true }}</strong>
            · Cash now: <strong>{{ cash() | usd }}</strong>
            @if (form.controls.cashAfterClose.dirty) {
              · <button class="link" type="button" (click)="recalculate()">Use calculated {{ suggestedCash() | usd }}</button>
            }
          </p>

          @if (error(); as message) {
            <p class="error" role="alert">{{ message }}</p>
          }

          <div class="actions">
            <button class="btn" type="button" (click)="dialog.close()">Cancel</button>
            <button class="btn primary" type="submit" [disabled]="form.invalid || saving()">
              {{ saving() ? 'Saving…' : 'Close Trade' }}
            </button>
          </div>
        </form>
      }
    </dialog>
  `,
  styles: `
    dialog {
      width: min(520px, calc(100vw - 32px));
      padding: 20px;
      border: 1px solid var(--hairline);
      border-radius: 12px;
      background: var(--surface);
      color: var(--ink);
    }
    dialog::backdrop { background: rgb(0 0 0 / 0.35); }
    h2 { font-family: var(--font-display); font-size: 18px; font-weight: 600; margin: 0 0 4px; }
    .summary { font-family: var(--font-mono); font-size: 12.5px; color: var(--ink-muted); margin: 0 0 14px; }
    .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    label { display: flex; flex-direction: column; gap: 4px; }
    label span { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); }
    input {
      font-family: var(--font-mono); font-size: 13px; padding: 7px 10px;
      border: 1px solid var(--hairline); border-radius: 7px; background: var(--surface); color: var(--ink);
    }
    input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    input.ng-invalid.ng-touched { border-color: var(--loss); }
    .cost { font-family: var(--font-mono); font-size: 12.5px; color: var(--ink-muted); margin: 14px 0 0; }
    .cost strong { color: var(--ink); }
    .cost strong.profit { color: var(--profit); }
    .cost strong.loss { color: var(--loss); }
    .link { font: inherit; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
    .error { color: var(--loss); background: var(--loss-bg); font-size: 12.5px; padding: 8px 10px; border-radius: 7px; margin: 12px 0 0; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  `,
})
export class CloseTradeDialog {
  private readonly tradesService = inject(TradesService);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly trade = signal<Trade | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly cash = this.tradesService.cash;

  protected readonly form = this.fb.group({
    exitPrice: [null as number | null, [Validators.required, Validators.min(0)]],
    closedAt: [localDateTime(), Validators.required],
    exitType: ['manual'],
    cashAfterClose: [null as number | null, Validators.required],
  });

  private readonly value = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  protected readonly proceeds = computed(() => (this.value().exitPrice ?? 0) * (this.trade()?.contracts ?? 0) * 100);
  protected readonly pnl = computed(() => {
    const t = this.trade();
    return t ? this.proceeds() - t.entryPrice * t.contracts * 100 : 0;
  });
  protected readonly suggestedCash = computed(() => Math.round((this.cash() + this.proceeds()) * 100) / 100);

  constructor() {
    // Keep the cash field on the calculated value until the user types their own.
    effect(() => {
      const suggested = this.suggestedCash();
      const control = this.form.controls.cashAfterClose;
      if (!control.dirty && control.value !== suggested) control.setValue(suggested);
    });
  }

  /** `prefill` comes from an exit signal on the Look For Trades tab. */
  open(trade: Trade, prefill?: { exitPrice: number | null; exitType: string }): void {
    this.trade.set(trade);
    this.reset();
    if (prefill) {
      this.form.patchValue({ exitPrice: prefill.exitPrice != null ? Math.round(prefill.exitPrice * 100) / 100 : null, exitType: prefill.exitType });
    }
    this.dialog().nativeElement.showModal();
  }

  protected recalculate(): void {
    this.form.controls.cashAfterClose.setValue(this.suggestedCash());
    this.form.controls.cashAfterClose.markAsPristine();
  }

  protected reset(): void {
    this.form.reset({ exitPrice: null, closedAt: localDateTime(), exitType: 'manual', cashAfterClose: this.suggestedCash() });
    this.error.set(null);
  }

  protected async save(trade: Trade): Promise<void> {
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.tradesService.closeTrade(trade, {
        exitPrice: v.exitPrice!,
        closedAt: new Date(v.closedAt),
        exitType: v.exitType,
        cashAfterClose: v.cashAfterClose!,
      });
      this.dialog().nativeElement.close();
    } catch (err) {
      this.error.set(`Couldn't close the trade: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.saving.set(false);
    }
  }
}
