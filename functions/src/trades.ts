import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { STARTING_ACCOUNT_VALUE, TRADES_COLLECTION, db, requireSignIn } from './admin.js';

/** Fills in `pnl` when a trade gets an exit price, so the client doesn't have to. */
export const computeTradePnl = onDocumentWritten(`${TRADES_COLLECTION}/{tradeId}`, async (event) => {
  const after = event.data?.after;
  const trade = after?.data();
  if (!after || !trade) return; // deleted

  const { entryPrice, exitPrice, contracts = 1, pnl } = trade;
  if (exitPrice == null || entryPrice == null) return;

  const computed = Math.round((Number(exitPrice) - Number(entryPrice)) * Number(contracts) * 100 * 100) / 100;
  if (pnl === computed) return; // already up to date; also stops this write from re-triggering forever

  logger.info('Setting pnl', { tradeId: event.params.tradeId, pnl: computed });
  await after.ref.update({ pnl: computed });
});

/** Callable from the client: account summary for a given year, computed server-side. */
export const tradeSummary = onCall<{ year?: string }>(async (request) => {
  requireSignIn(request);
  const year = request.data?.year ?? String(new Date().getFullYear());
  if (!/^\d{4}$/.test(year)) throw new HttpsError('invalid-argument', 'year must be YYYY');

  const snap = await db.collection(TRADES_COLLECTION).get();
  const trades: DocumentData[] = snap.docs
    .map((doc: QueryDocumentSnapshot) => doc.data())
    .filter((t: DocumentData) => {
      const openedAt = t.openedAt?.toDate?.() ?? (t.openedAt ? new Date(t.openedAt) : null);
      return openedAt && String(openedAt.getFullYear()) === year;
    });

  const closed = trades.filter((t) => t.pnl != null);
  const pnl = closed.reduce((sum, t) => sum + Number(t.pnl), 0);
  // A break-even take-profit exit counts as a win. Keep in sync with isWin in src/app/trades/trade.model.ts.
  const wins = closed.filter((t) => Number(t.pnl) > 0 || (Number(t.pnl) === 0 && t.exitType === 'take-profit')).length;

  return {
    year,
    start: STARTING_ACCOUNT_VALUE,
    end: STARTING_ACCOUNT_VALUE + pnl,
    pnl,
    closed: closed.length,
    open: trades.length - closed.length,
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
  };
});
