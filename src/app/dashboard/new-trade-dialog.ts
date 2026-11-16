import { Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { TradesService } from '../trades/trades.service';
import { UsdPipe } from '../trades/format';

/** Value for a datetime-local input, in the browser's local time. */
function localDateTime(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export interface NewTradePrefill {
  ticker: string;
  strike: number | null;
  exp: string;
  contracts: number;
}

@Component({
  selector: 'app-new-trade-dialog',
  imports: [ReactiveFormsModule, UsdPipe],
  template: `
    @if (showButton()) {
      <button class="btn primary" type="button" (click)="open()" [disabled]="!configured">+ New Trade</button>
    }

    <dialog #dialog (close)="reset()" aria-labelledby="new-trade-title">
      <form [formGroup]="form" (ngSubmit)="save()">
        <h2 id="new-trade-title">New Trade</h2>
        <div class="fields">
          <label>
            <span>Ticker</span>
            <input formControlName="ticker" autocomplete="off" placeholder="TSLA" />
          </label>
          <label>
            <span>Opened</span>
            <input type="datetime-local" formControlName="openedAt" />
          </label>
          <label>
            <span>Strike</span>
            <input type="number" step="0.5" min="0" formControlName="strike" placeholder="400.00" />
          </label>
          <label>
            <span>Expiration</span>
            <input type="date" formControlName="exp" />
          </label>
          <label>
            <span>Contracts</span>
            <input type="number" step="1" min="1" formControlName="contracts" />
          </label>
          <label>
            <span>Entry price / contract</span>
            <input type="number" step="0.01" min="0" formControlName="entryPrice" placeholder="25.00" />
          </label>
          <label>
            <span>Cash after trade</span>
            <input type="number" step="0.01" formControlName="cashAfterOpen" />
          </label>
        </div>

        <p class="cost">
          Cost: <strong>{{ cost() | usd }}</strong> · Cash now: <strong>{{ cash() | usd }}</strong>
          @if (form.controls.cashAfterOpen.dirty) {
            · <button class="link" type="button" (click)="recalculate()">Use calculated {{ suggestedCash() | usd }}</button>
          }
        </p>

        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }

        <div class="actions">
          <button class="btn" type="button" (click)="dialog.close()">Cancel</button>
          <button class="btn primary" type="submit" [disabled]="form.invalid || saving()">
            {{ saving() ? 'Saving…' : 'Add Trade' }}
          </button>
        </div>
      </form>
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
    h2 { font-family: var(--font-display); font-size: 18px; font-weight: 600; margin: 0 0 14px; }
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
    .link { font: inherit; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
    .error { color: var(--loss); background: var(--loss-bg); font-size: 12.5px; padding: 8px 10px; border-radius: 7px; margin: 12px 0 0; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  `,
})
export class NewTradeDialog {
  /** False when another screen opens the dialog itself through open(prefill). */
  readonly showButton = input(true);

  private readonly tradesService = inject(TradesService);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly configured = this.tradesService.configured;
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = this.fb.group({
    ticker: ['TSLA', [Validators.required, Validators.pattern(/^\s*[A-Za-z.]{1,6}\s*$/)]],
    openedAt: [localDateTime(), Validators.required],
    strike: [null as number | null, [Validators.required, Validators.min(0.01)]],
    exp: ['', Validators.required],
    contracts: [1, [Validators.required, Validators.min(1)]],
    entryPrice: [null as number | null, [Validators.required, Validators.min(0.01)]],
    cashAfterOpen: [null as number | null, Validators.required],
  });

  private readonly value = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  protected readonly cost = computed(() => (this.value().entryPrice ?? 0) * (this.value().contracts ?? 0) * 100);
  protected readonly cash = this.tradesService.cash;
  protected readonly suggestedCash = computed(() => Math.round((this.cash() - this.cost()) * 100) / 100);

  constructor() {
    // Keep the cash field on the calculated value until the user types their own.
    effect(() => {
      const suggested = this.suggestedCash();
      const control = this.form.controls.cashAfterOpen;
      if (!control.dirty && control.value !== suggested) control.setValue(suggested);
    });
  }

  /**
   * Opens the dialog, optionally filled from an entry signal. A prefilled trade leaves the entry
   * price and cash blank for the user to enter what they actually got.
   */
  open(prefill?: NewTradePrefill): void {
    if (prefill) {
      this.form.patchValue({ ...prefill, openedAt: localDateTime(), entryPrice: null });
      const cash = this.form.controls.cashAfterOpen;
      cash.setValue(null);
      cash.markAsDirty(); // stops the effect from filling in the calculated amount
    }
    this.dialog().nativeElement.showModal();
  }

  protected recalculate(): void {
    this.form.controls.cashAfterOpen.setValue(this.suggestedCash());
    this.form.controls.cashAfterOpen.markAsPristine();
  }

  protected reset(): void {
    this.form.reset({
      ticker: 'TSLA',
      openedAt: localDateTime(),
      contracts: 1,
      exp: '',
      strike: null,
      entryPrice: null,
      cashAfterOpen: this.suggestedCash(),
    });
    this.error.set(null);
  }

  protected async save(): Promise<void> {
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.tradesService.addTrade({
        ticker: v.ticker,
        strike: v.strike!,
        exp: v.exp,
        contracts: v.contracts,
        entryPrice: v.entryPrice!,
        openedAt: new Date(v.openedAt),
        cashAfterOpen: v.cashAfterOpen!,
      });
      this.dialog().nativeElement.close();
    } catch (err) {
      this.error.set(`Couldn't save the trade: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.saving.set(false);
    }
  }
}
