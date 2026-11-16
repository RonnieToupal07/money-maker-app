import { Component, ElementRef, OnDestroy, afterNextRender, computed, inject, input, signal } from '@angular/core';
import { CtTimePipe, UsdPipe } from '../trades/format';

export interface BalancePoint {
  time: string;
  value: number;
}

const HEIGHT = 170;
const PAD = { left: 6, right: 6, top: 24, bottom: 22 };
const monthFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short' });

/** Step chart of account value, re-marked at every closed trade. */
@Component({
  selector: 'app-account-chart',
  imports: [UsdPipe, CtTimePipe],
  template: `
    @if (points().length > 1) {
      <svg
        class="spark"
        [attr.viewBox]="'0 0 ' + width() + ' ' + height"
        [attr.height]="height"
        (pointermove)="onHover($event)"
        (pointerleave)="hoverIndex.set(null)"
      >
        <line class="grid" [attr.x1]="pad.left" [attr.x2]="width() - pad.right" [attr.y1]="points()[0].y" [attr.y2]="points()[0].y" />
        <text [attr.x]="pad.left" [attr.y]="points()[0].y - 5">start {{ points()[0].value | usd }}</text>
        <path class="fill" [attr.d]="linePath() + fillTail()" />
        <path class="line" [attr.d]="linePath()" />
        @for (label of monthLabels(); track label.x) {
          <text [attr.x]="label.x" [attr.y]="height - 4">{{ label.text }}</text>
        }
        @if (points().at(-1); as p) {
          <circle class="dot" [attr.cx]="p.x" [attr.cy]="p.y" r="3" />
          <text class="end-label" [attr.x]="p.x - 4" [attr.y]="p.y - 8" text-anchor="end">{{ p.value | usd }}</text>
        }
        @if (hovered(); as h) {
          <line class="cursor" [attr.x1]="h.x" [attr.x2]="h.x" [attr.y1]="pad.top" [attr.y2]="height - pad.bottom" />
          <circle class="dot" [attr.cx]="h.x" [attr.cy]="h.y" r="3.5" />
        }
      </svg>
      <div class="readout">
        @if (hovered(); as h) {
          {{ h.time | ct }} · <strong>{{ h.value | usd }}</strong>
        } @else {
          Hover the chart to read the balance after each close.
        }
      </div>
    } @else {
      <div class="empty-note">No closed trades yet — the chart fills in as trades close.</div>
    }
  `,
  styles: `
    :host { display: block; }
    svg.spark { display: block; width: 100%; touch-action: none; }
    text { font-family: var(--font-mono); font-size: 10px; fill: var(--ink-muted); }
    .end-label { fill: var(--ink); font-weight: 600; }
    .fill { fill: var(--accent); opacity: 0.12; }
    .line { fill: none; stroke: var(--accent); stroke-width: 1.5; }
    .dot { fill: var(--accent); }
    .grid { stroke: var(--hairline); stroke-dasharray: 3 3; }
    .cursor { stroke: var(--ink-muted); opacity: 0.5; }
    .readout { font-family: var(--font-mono); font-size: 11.5px; color: var(--ink-muted); margin-top: 6px; min-height: 1.4em; }
  `,
})
export class AccountChart implements OnDestroy {
  /** First point is the starting balance; the rest are balances after each close. */
  readonly series = input.required<BalancePoint[]>();

  protected readonly height = HEIGHT;
  protected readonly pad = PAD;
  protected readonly width = signal(640);
  protected readonly hoverIndex = signal<number | null>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private observer?: ResizeObserver;

  constructor() {
    // Size the viewBox to the real pixel width so text never stretches.
    afterNextRender(() => {
      this.observer = new ResizeObserver(([entry]) => this.width.set(Math.max(280, Math.round(entry.contentRect.width))));
      this.observer.observe(this.host.nativeElement);
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  protected readonly points = computed(() => {
    const series = this.series();
    const values = series.map((s) => s.value);
    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    const step = (this.width() - PAD.left - PAD.right) / Math.max(1, series.length - 1);
    const innerH = HEIGHT - PAD.top - PAD.bottom;
    return series.map((s, i) => ({
      ...s,
      x: PAD.left + i * step,
      y: PAD.top + (1 - (s.value - min) / span) * innerH,
    }));
  });

  protected readonly hovered = computed(() => {
    const i = this.hoverIndex();
    return i == null ? null : this.points()[i];
  });

  protected readonly linePath = computed(() => {
    const [first, ...rest] = this.points();
    return first ? `M ${first.x},${first.y} ` + rest.map((p) => `H ${p.x} V ${p.y}`).join(' ') : '';
  });

  protected readonly fillTail = computed(() => ` V ${HEIGHT - PAD.bottom} H ${PAD.left} Z`);

  protected readonly monthLabels = computed(() => {
    const labels: { x: number; text: string }[] = [];
    let lastMonth = '';
    let lastX = -Infinity;
    for (const p of this.points().slice(1)) {
      const text = monthFormat.format(new Date(p.time));
      if (text !== lastMonth && p.x - lastX > 30 && p.x < this.width() - 24) {
        labels.push({ x: p.x, text });
        lastX = p.x;
      }
      lastMonth = text;
    }
    return labels;
  });

  protected onHover(event: PointerEvent): void {
    const svg = event.currentTarget as SVGSVGElement;
    const x = ((event.clientX - svg.getBoundingClientRect().left) / svg.clientWidth) * this.width();
    const pts = this.points();
    let best = 0;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i].x - x) < Math.abs(pts[best].x - x)) best = i;
    }
    this.hoverIndex.set(best);
  }
}
