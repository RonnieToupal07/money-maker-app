import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { FearGreedService } from '../trades/fear-greed.service';

/**
 * "Enter" link on the Fear & Greed stat: records CNN's Fear & Greed close for a trading day. A
 * noon text goes out on weekdays when the previous trading day's value is missing.
 */
@Component({
  selector: 'app-fear-greed-dialog',
  imports: [ReactiveFormsModule],
  template: `
    <button class="link" type="button" (click)="open()">Enter</button>

    <dialog #dialog (close)="error.set(null)" aria-labelledby="fear-greed-title">
      <form (ngSubmit)="save()">
        <h2 id="fear-greed-title">Fear &amp; Greed</h2>
        <p class="note">
          CNN's Fear &amp; Greed value at a trading day's close. Signals use the latest reading from before their own day,
          so enter each day's value after the close (or before the next open).
        </p>
        <div class="fields">
          <label>
            <span>Trading day</span>
            <input type="date" [formControl]="date" />
          </label>
          <label>
            <span>Value (0–100)</span>
            <input type="number" step="0.01" min="0" max="100" [formControl]="value" />
          </label>
        </div>
        @if (state()?.recent?.length) {
          <p class="recent">
            Recent:
            @for (r of state()!.recent; track r.date) {
              <span>{{ r.date.slice(5) }} {{ r.value }}</span>
            }
          </p>
        }

        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }

        <div class="actions">
          <button class="btn" type="button" (click)="dialog.close()">Cancel</button>
          <button class="btn primary" type="submit" [disabled]="date.invalid || value.invalid || saving()">
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
      text-transform: none;
      letter-spacing: normal;
    }
    dialog::backdrop { background: rgb(0 0 0 / 0.35); }
    h2 { font-family: var(--font-display); font-size: 18px; font-weight: 600; margin: 0 0 8px; }
    .note { font-size: 12.5px; color: var(--ink-muted); margin: 0 0 14px; }
    .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    label { display: flex; flex-direction: column; gap: 4px; }
    label span { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); }
    input {
      font-family: var(--font-mono); font-size: 13px; padding: 7px 10px; min-width: 0;
      border: 1px solid var(--hairline); border-radius: 7px; background: var(--surface); color: var(--ink);
    }
    input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    .recent { font-size: 12px; color: var(--ink-muted); margin: 12px 0 0; display: flex; flex-wrap: wrap; gap: 4px 10px; }
    .recent span { font-family: var(--font-mono); }
    .error { color: var(--loss); background: var(--loss-bg); font-size: 12.5px; padding: 8px 10px; border-radius: 7px; margin: 12px 0 0; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  `,
})
export class FearGreedDialog {
  private readonly fearGreed = inject(FearGreedService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly state = this.fearGreed.state;
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly date = new FormControl<string>('', { nonNullable: true, validators: Validators.required });
  protected readonly value = new FormControl<number | null>(null, [Validators.required, Validators.min(0), Validators.max(100)]);

  protected open(): void {
    this.date.reset(this.state()?.needed ?? '');
    this.value.reset(null);
    this.dialog().nativeElement.showModal();
  }

  protected async save(): Promise<void> {
    const value = this.value.value;
    if (value == null || this.value.invalid || this.date.invalid) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.fearGreed.save(this.date.value, value);
      this.dialog().nativeElement.close();
    } catch (err) {
      this.error.set(`Couldn't save: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.saving.set(false);
    }
  }
}
