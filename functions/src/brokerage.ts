import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { requireSignIn } from './admin.js';
import { sendAlert } from './entries.js';
import { schwabConfigured } from './schwab/client.js';
import { cleanUpBotOrders } from './schwab/execute.js';
import { RecordResult, recordOrders, syncBalances } from './schwab/sync.js';

export { schwabAuth, schwabConnectUrl } from './schwab/auth.js';

interface SyncResult {
  cashAvailable: number;
  accountValue: number;
  syncedAt: string;
  recorded: RecordResult;
}

async function syncAll(): Promise<SyncResult> {
  const balances = await syncBalances();
  const recorded = await recordOrders(balances.cashAvailable);
  return { cashAvailable: balances.cashAvailable, accountValue: balances.accountValue, syncedAt: balances.syncedAt, recorded };
}

/** Dashboard "Sync Schwab" button: balances, open contracts, and any BTO/STC fills not logged yet. */
export const syncSchwab = onCall({ timeoutSeconds: 120 }, async (request): Promise<SyncResult> => {
  requireSignIn(request);
  if (!schwabConfigured()) throw new HttpsError('failed-precondition', 'Schwab is not set up in functions/.env');
  try {
    return await syncAll();
  } catch (err) {
    logger.error('syncSchwab failed', err);
    throw new HttpsError('internal', (err as Error).message);
  }
});

/**
 * Every 5 minutes through the trading day (8:30 AM-3:10 PM CT, weekdays): finishes any auto-trade
 * order a crashed run left behind, then picks up BTO/STC orders placed by hand in Schwab, so they
 * open and close trades in the log without a manual sync.
 */
export const schwabOrderSync = onSchedule(
  { schedule: '*/5 8-15 * * 1-5', timeZone: 'America/Chicago', timeoutSeconds: 120, maxInstances: 1, retryCount: 0 },
  async () => {
    if (!schwabConfigured()) return;
    const ct = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false });
    const [hour, minute] = ct.format(new Date()).split(':').map(Number);
    const minutes = (hour % 24) * 60 + minute;
    if (minutes < 8 * 60 + 30 || minutes > 15 * 60 + 10) return;
    try {
      const recovered = await cleanUpBotOrders();
      if (recovered.length) {
        await sendAlert(`Money Maker: an auto-trade run stopped before finishing. Orders recovered:\n${recovered.join('\n')}`);
      }
      // Trades closed by a fill this sync found first (a resting take profit, or a sale by hand).
      const { recorded } = await syncAll();
      if (recorded.lines.length) await sendAlert(`Money Maker:\n${recorded.lines.join('\n')}`);
    } catch (err) {
      logger.warn('Schwab order sync failed', { error: (err as Error).message });
    }
  },
);
