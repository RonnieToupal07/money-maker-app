import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { TradesService } from '../trades/trades.service';
import { UsdPipe } from '../trades/format';

/** "Update" link on the Cash Available stat: records the account's actual free cash as of now. */
@Component({
  selector: 'app-update-cash-dialog',
  imports: [ReactiveFormsModule, UsdPipe],
  template: `
    <button class="link" type="button" (click)="open()" [disabled]="!configured">Update</button>

    <dialog #dialog (close)="error.set(null)" aria-labelledby="update-cash-title">
      <form (ngSubmit)="save()">
        <h2 id="update-cash-title">Update Cash</h2>
        <p class="note">
          Currently {{ cash() | usd }}. The amount you enter becomes free cash as of now; trades opened or closed
          afterwards adjust from it. The entry check and alerts use it too.
        </p>
        <label>
          <span>Cash available</span>
          <input type="number" step="0.01" [formControl]="amount" />
        </label>

        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }

        <div class="actions">
          <button class="btn" type="button" (click)="dialog.close()">Cancel</button>
          <button class="btn primary" type="submit" [disabled]="amount.invalid || saving()">
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </form>
    </dialog>
  `,
  styles: `
    .link {
      font: inherit; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline;
    }
    dialog {
      width: min(400px, calc(100vw - 32px));
      padding: 20px;
      border: 1px solid var(--hairline);
      border-radius: 12px;
      background: var(--surface);
      color: var(--ink);
    }
    dialog::backdrop { background: rgb(0 0 0 / 0.35); }
    h2 { font-family: var(--font-display); font-size: 18px; font-weight: 600; margin: 0 0 8px; }
    .note { font-size: 12.5px; color: var(--ink-muted); margin: 0 0 14px; }
    label { display: flex; flex-direction: column; gap: 4px; }
    label span { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); }
    input {
      font-family: var(--font-mono); font-size: 13px; padding: 7px 10px;
      border: 1px solid var(--hairline); border-radius: 7px; background: var(--surface); color: var(--ink);
    }
    input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    .error { color: var(--loss); background: var(--loss-bg); font-size: 12.5px; padding: 8px 10px; border-radius: 7px; margin: 12px 0 0; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  `,
})
export class UpdateCashDialog {
  private readonly tradesService = inject(TradesService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly configured = this.tradesService.configured;
  protected readonly cash = this.tradesService.cash;
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly amount = new FormControl<number | null>(null, Validators.required);

  protected open(): void {
    this.amount.reset(Math.round(this.cash() * 100) / 100);
    this.dialog().nativeElement.showModal();
  }

  protected async save(): Promise<void> {
    const cash = this.amount.value;
    if (cash == null || this.amount.invalid) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.tradesService.updateCash(cash);
      this.dialog().nativeElement.close();
    } catch (err) {
      this.error.set(`Couldn't update cash: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.saving.set(false);
    }
  }
}
