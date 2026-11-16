import { TestBed } from '@angular/core/testing';
import { Timestamp } from 'firebase/firestore';
import { App } from './app';
import { fromDoc, tradeStats } from './trades/trade.model';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    })
      .compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });
});

describe('trade model', () => {
  it('maps a closed trade document and derives P&L when missing', () => {
    const t = fromDoc('a', {
      ticker: 'TSLA',
      strike: 400,
      exp: '2026-01-09',
      contracts: 2,
      entryPrice: 20,
      exitPrice: 25,
      openedAt: Timestamp.fromDate(new Date('2026-01-02T14:30:00Z')),
      closedAt: '2026-01-02T15:30:00Z',
    });
    expect(t).toMatchObject({ id: 'a', pnl: 1000, openedAt: '2026-01-02T14:30:00.000Z', closedAt: '2026-01-02T15:30:00.000Z' });
  });

  it('leaves open trades without P&L', () => {
    expect(fromDoc('b', { ticker: 'TSLA', entryPrice: 20, openedAt: '2026-01-05T14:30:00Z' })).toMatchObject({ pnl: null, closedAt: null });
  });

  it('summarizes trades against the starting value', () => {
    const trades = [
      fromDoc('a', { entryPrice: 20, pnl: 500, openedAt: '2026-01-02T14:30:00Z', closedAt: '2026-01-02T15:30:00Z' }),
      fromDoc('b', { entryPrice: 30, pnl: -350, openedAt: '2026-01-05T14:30:00Z', closedAt: '2026-01-06T14:30:00Z' }),
      fromDoc('c', { entryPrice: 30, openedAt: '2026-01-07T14:30:00Z' }),
    ];
    expect(tradeStats(trades, 10000)).toMatchObject({ end: 10150, pnl: 150, closed: 2, open: 1, winRate: 50 });
    expect(tradeStats([], 10000)).toMatchObject({ end: 10000, pnl: 0, closed: 0, winRate: 0 });
  });

  it('counts a $0 take-profit exit as a win but not a $0 manual exit', () => {
    const trades = [
      fromDoc('a', { entryPrice: 20, pnl: 0, exitType: 'take-profit', openedAt: '2026-01-02T14:30:00Z' }),
      fromDoc('b', { entryPrice: 20, pnl: 0, exitType: 'manual', openedAt: '2026-01-05T14:30:00Z' }),
    ];
    expect(tradeStats(trades, 10000)).toMatchObject({ closed: 2, winRate: 50 });
  });
});
