import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CtTimePipe, PctPipe, UsdPipe } from '../trades/format';
import { BrokerageService, SchwabOptionPosition } from '../trades/brokerage.service';
import { HOLD_CANDLES, Trade, candlesHeld, isStrategyTrade } from '../trades/trade.model';
import { TradesService } from '../trades/trades.service';

interface Row {
  key: string;
  label: string;
  position: SchwabOptionPosition | null;
  trade: Trade | null;
  /** 30-min candles closed since the logged trade's entry; null when there's no strategy trade to count from. */
  candles: number | null;
}

const contractKey = (ticker: string, strike: number, exp: string, putCall: string) => `${ticker.toUpperCase()}|${strike}|${exp}|${putCall}`;

/**
 * Open option contracts as Schwab reports them (brokerage/schwab, refreshed by every sync),
 * lined up against the open trades in the log so a mismatch stands out.
 */
@Component({
  selector: 'app-schwab-positions',
  imports: [UsdPipe, PctPipe, CtTimePipe],
  template: `
    <div class="panel-head">
      <h2>Open Contracts · Schwab</h2>
      <div class="head-actions">
        @if (account(); as a) {
          <span class="synced">Synced {{ a.syncedAt | ct }}</span>
        }
        <button class="btn" type="button" (click)="sync()" [disabled]="syncing()">{{ syncing() ? 'Syncing…' : 'Sync Schwab' }}</button>
      </div>
    </div>

    @if (message(); as m) {
      <p class="note">{{ m }}</p>
    }

    @if (!account()) {
      <div class="empty-note">Schwab isn't connected yet. Open your connect link, then press Sync Schwab.</div>
    } @else {
      <div class="table-scroll">
        <table class="log">
          <thead>
            <tr>
              <th>Contract</th>
              <th>Qty</th>
              <th title="30-min candles closed since entry; the strategy force-exits at {{ holdCandles }}">Candles</th>
              <th>Avg Price</th>
              <th>Mark</th>
              <th>Market Value</th>
              <th>Open P&amp;L</th>
              <th>% Gain/Loss</th>
              <th>Day P&amp;L</th>
              <th>Trade Log</th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.key) {
              @let p = r.position;
              <tr [class.row-open]="p && r.trade" [class.mismatch]="!p">
                <td>{{ r.label }}</td>
                <td>{{ p ? p.quantity : '—' }}</td>
                <td>
                  @if (r.candles == null) {
                    —
                  } @else {
                    <span class="candles" [class.due]="r.candles >= holdCandles">
                      {{ r.candles }} / {{ holdCandles }}
                      <span class="meter" aria-hidden="true"><span [style.width.%]="(r.candles / holdCandles) * 100"></span></span>
                    </span>
                  }
                </td>
                <td>{{ p?.averagePrice | usd }}</td>
                <td>{{ p && p.quantity ? (p.marketValue / p.quantity / 100 | usd) : '—' }}</td>
                <td>{{ p?.marketValue | usd }}</td>
                <td>
                  @if (p) {
                    <span class="pnl" [class.profit]="p.openProfitLoss > 0" [class.loss]="p.openProfitLoss < 0">{{ p.openProfitLoss | usd: true }}</span>
                  } @else {
                    —
                  }
                </td>
                <td>
                  @let pct = gainPct(p);
                  <span class="pnl" [class.profit]="(pct ?? 0) > 0" [class.loss]="(pct ?? 0) < 0">{{ pct | pct: true }}</span>
                </td>
                <td>
                  @if (p?.dayProfitLoss != null) {
                    <span [class.profit]="p!.dayProfitLoss! > 0" [class.loss]="p!.dayProfitLoss! < 0">{{ p!.dayProfitLoss | usd: true }}</span>
                  } @else {
                    —
                  }
                </td>
                <td>
                  @if (p && r.trade) {
                    <span class="badge event-open">Logged · {{ r.trade.contracts }} @ {{ r.trade.entryPrice | usd }}</span>
                  } @else if (p) {
                    <span class="badge">Bought in Schwab · not managed</span>
                  } @else {
                    <span class="badge status-warn">Open in log, not held at Schwab</span>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="10" class="empty-note">No open option contracts at Schwab.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styles: `
    .synced { font-family: var(--font-mono); font-size: 11.5px; color: var(--ink-muted); align-self: center; }
    .note { font-family: var(--font-mono); font-size: 12px; color: var(--ink-muted); margin: 0 0 10px; }
    tr.mismatch { background: color-mix(in srgb, var(--loss) 6%, var(--surface)); }
    .badge.status-warn { color: var(--loss); background: var(--loss-bg); }
    .candles { display: inline-flex; align-items: center; gap: 6px; }
    .candles.due { color: var(--loss); font-weight: 700; }
    .candles .meter { display: inline-block; width: 44px; height: 4px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
    .candles .meter span { display: block; height: 100%; max-width: 100%; background: var(--open); }
    .candles.due .meter span { background: var(--loss); }
  `,
})
export class SchwabPositions {
  private readonly brokerage = inject(BrokerageService);
  private readonly tradesService = inject(TradesService);

  protected readonly account = this.brokerage.account;
  protected readonly syncing = this.brokerage.syncing;
  protected readonly message = this.brokerage.message;
  protected readonly holdCandles = HOLD_CANDLES;

  /** Ticks every 30s so the candle counts move on their own. */
  private readonly clock = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.clock.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected readonly rows = computed<Row[]>(() => {
    const now = this.clock();
    const candlesFor = (t: Trade | null): number | null => (t && isStrategyTrade(t) ? candlesHeld(t.openedAt, now) : null);
    const positions = this.account()?.positions ?? [];
    const openTrades = this.tradesService.trades().filter((t) => t.pnl == null);
    const tradeByKey = new Map(openTrades.map((t) => [contractKey(t.ticker, t.strike, t.exp, t.putCall), t]));
    const rows: Row[] = positions.map((p) => {
      const key = contractKey(p.ticker, p.strike, p.exp, p.putCall);
      const trade = tradeByKey.get(key) ?? null;
      tradeByKey.delete(key);
      return { key, label: `${p.ticker} ${p.exp} $${p.strike}${p.putCall}`, position: p, trade, candles: candlesFor(trade) };
    });
    for (const [key, t] of tradeByKey) rows.push({ key, label: `${t.ticker} ${t.exp} $${t.strike}${t.putCall}`, position: null, trade: t, candles: candlesFor(t) });
    return rows;
  });

  /** Open P&L as a percent of what the contracts cost; null when there's no position or cost. */
  protected gainPct(p: SchwabOptionPosition | null): number | null {
    const cost = p ? p.averagePrice * p.quantity * 100 : 0;
    return p && cost ? (p.openProfitLoss / cost) * 100 : null;
  }

  protected sync(): void {
    void this.brokerage.sync();
  }
}
