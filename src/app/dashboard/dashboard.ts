import { Component, WritableSignal, computed, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { LOG_START, STARTING_ACCOUNT_VALUE, YEAR } from '../firebase.config';
import { CtTimePipe, PctPipe, UsdPipe } from '../trades/format';
import { Trade, isWin, tradeStats } from '../trades/trade.model';
import { TradesService } from '../trades/trades.service';
import { AccountChart, BalancePoint } from './account-chart';
import { BlockedSignals } from './blocked-signals';
import { Router } from '@angular/router';
import { ScanService } from '../trades/scan.service';
import { BrokerageService } from '../trades/brokerage.service';
import { TradingSwitchService } from '../trades/trading-switch.service';
import { FearGreedService } from '../trades/fear-greed.service';
import { CloseTradeDialog } from './close-trade-dialog';
import { FearGreedDialog } from './fear-greed-dialog';
import { NewTradeDialog } from './new-trade-dialog';
import { SchwabPositions } from './schwab-positions';
import { UpdateCashDialog } from './update-cash-dialog';

type Theme = 'system' | 'light' | 'dark';

interface Transaction {
  key: string;
  action: 'BTO' | 'STC';
  time: string;
  trade: Trade;
  price: number;
  amount: number; // cash out (BTO, negative) or in (STC, positive)
  cashAfter: number | null;
}

const THEME_KEY = 'mm-theme';
const SCHWAB_HIDDEN_KEY = 'mm-schwab-hidden';
const CASH_HIDDEN_KEY = 'mm-cash-hidden';

@Component({
  selector: 'app-dashboard',
  imports: [UsdPipe, PctPipe, CtTimePipe, AccountChart, BlockedSignals, CloseTradeDialog, FearGreedDialog, NewTradeDialog, SchwabPositions, UpdateCashDialog],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private readonly tradesService = inject(TradesService);
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);
  private readonly scan = inject(ScanService);

  protected readonly year = YEAR;
  protected readonly isWin = isWin;
  protected readonly trades = this.tradesService.trades;
  protected readonly loading = this.tradesService.loading;
  protected readonly error = this.tradesService.error;
  protected readonly cash = this.tradesService.cash;
  protected readonly configured = this.tradesService.configured;
  protected readonly scanRunning = this.scan.running;
  private readonly brokerage = inject(BrokerageService);
  protected readonly schwab = this.brokerage.account;
  protected readonly schwabSyncing = this.brokerage.syncing;
  protected readonly schwabReconnecting = this.brokerage.reconnecting;
  protected readonly schwabMessage = this.brokerage.message;
  /** Schwab value starts blurred; the eye button reveals it and the choice is remembered. */
  protected readonly schwabHidden = signal(this.readHidden(SCHWAB_HIDDEN_KEY));
  /** Cash Available works the same way, remembered separately. */
  protected readonly cashHidden = signal(this.readHidden(CASH_HIDDEN_KEY));
  protected readonly now = Date.now();
  protected readonly fearGreed = inject(FearGreedService).state;
  private readonly tradingSwitchService = inject(TradingSwitchService);
  protected readonly tradingSwitch = this.tradingSwitchService.state;
  protected readonly tradingSwitchSaving = this.tradingSwitchService.saving;
  protected readonly tradingSwitchError = this.tradingSwitchService.error;

  /** Off is immediate; on asks first, since it lets the strategy place real orders by itself. */
  protected toggleAutoTrading(): void {
    const enabled = !this.tradingSwitch()?.enabled;
    if (enabled && !this.document.defaultView?.confirm('Turn auto-trading on? The strategy will place real orders on your Schwab account by itself.')) return;
    void this.tradingSwitchService.set(enabled);
  }

  protected syncSchwab(): void {
    void this.brokerage.sync();
  }

  protected reconnectSchwab(): void {
    void this.brokerage.reconnect();
  }
  protected readonly stats = computed(() => tradeStats(this.trades(), STARTING_ACCOUNT_VALUE));
  protected readonly theme = signal<Theme>(this.readTheme());

  protected readonly logStart = LOG_START;

  /** One BTO line per trade and one STC line per closed trade, newest first. */
  protected readonly transactions = computed<Transaction[]>(() => {
    const lines: Transaction[] = [];
    for (const t of this.trades()) {
      lines.push({
        key: `${t.id}-bto`,
        action: 'BTO',
        time: t.openedAt,
        trade: t,
        price: t.entryPrice,
        amount: -t.entryPrice * t.contracts * 100,
        cashAfter: t.cashAfterOpen,
      });
      if (t.exitPrice != null) {
        lines.push({
          key: `${t.id}-stc`,
          action: 'STC',
          time: t.closedAt ?? t.openedAt,
          trade: t,
          price: t.exitPrice,
          amount: t.exitPrice * t.contracts * 100,
          cashAfter: t.cashAfterClose,
        });
      }
    }
    return lines.sort((a, b) => b.time.localeCompare(a.time) || (a.action === 'STC' ? -1 : 1));
  });

  protected readonly balance = computed<BalancePoint[]>(() => {
    const closed = this.trades()
      .filter((t) => t.closedAt && t.pnl != null)
      .sort((a, b) => a.closedAt!.localeCompare(b.closedAt!));
    let value = STARTING_ACCOUNT_VALUE;
    return [
      { time: closed[0]?.openedAt ?? '', value },
      ...closed.map((t) => ({ time: t.closedAt!, value: (value += t.pnl!) })),
    ];
  });

  constructor() {
    this.applyTheme(this.theme());
  }

  /** Runs the entry + exit check and shows it on the Look For Trades tab. */
  protected lookForTrades(): void {
    void this.scan.run();
    void this.router.navigate(['/look-for-trades']);
  }

  protected cycleTheme(): void {
    const next: Theme = this.theme() === 'system' ? 'light' : this.theme() === 'light' ? 'dark' : 'system';
    this.theme.set(next);
    this.applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage unavailable (private mode etc.) — theme just won't persist.
    }
  }

  protected toggleSchwabHidden(): void {
    this.toggleHidden(this.schwabHidden, SCHWAB_HIDDEN_KEY);
  }

  protected toggleCashHidden(): void {
    this.toggleHidden(this.cashHidden, CASH_HIDDEN_KEY);
  }

  private toggleHidden(state: WritableSignal<boolean>, key: string): void {
    const hidden = !state();
    state.set(hidden);
    try {
      localStorage.setItem(key, String(hidden));
    } catch {
      // Storage unavailable — the choice just won't persist.
    }
  }

  /** Hidden unless the viewer chose to show it. */
  private readHidden(key: string): boolean {
    try {
      return localStorage.getItem(key) !== 'false';
    } catch {
      return true;
    }
  }

  private readTheme(): Theme {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved === 'light' || saved === 'system' ? saved : 'dark';
    } catch {
      return 'dark';
    }
  }

  private applyTheme(theme: Theme): void {
    const root = this.document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }
}
