import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, requireSignIn } from './admin.js';
import { loadAccountState } from './account.js';
import { EVENTS_COLLECTION, logEvent, report } from './eventLog.js';
import { sendSms } from './sms.js';
import { MACDEXP, TICKERS } from './strategy/config.js';
import { fearGreedBefore, fillFearGreedFromCnn, loadFearGreed, setFearGreedReading } from './strategy/fearGreed.js';
import { EntrySignal, ExitCheck, ScanResult, scanForEntries } from './strategy/macdexpLive.js';
import { addDays, etParts } from './strategy/history.js';
import { etToday, updateIvSeries } from './strategy/ivSeries.js';
import { getAggs30Min } from './strategy/massive.js';
import { refreshExpiresAt, schwabConfigured } from './schwab/client.js';
import { createPendingEntries, workOrders } from './schwab/entryOrders.js';
import { ExecuteOptions, executeExits } from './schwab/execute.js';
import { syncBalances } from './schwab/sync.js';

/** Reads a value from functions/.env, which Firebase loads on deploy and in the emulator. */
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in functions/.env`);
  return value;
}

// One doc per entry alert already texted, keyed by ticker + candle, so a rescan of the same
// candle doesn't text the same signal again.
const ALERTS_COLLECTION = 'entryAlerts';

const scanOptions = { timeoutSeconds: 300, memory: '1GiB' as const };

/**
 * "Look For Trades" tab: runs the live entry check on every ticker and the exit check on every
 * open trade right now, returning each one's values and why it does or doesn't qualify.
 */
export const checkForEntries = onCall(scanOptions, async (request): Promise<ScanResult> => {
  requireSignIn(request);
  try {
    return await scanForEntries(await loadAccountState());
  } catch (err) {
    logger.error('checkForEntries failed', err);
    throw new HttpsError('internal', (err as Error).message);
  }
});

const ctFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false,
});
function ctMinutes(date: Date): number {
  const p = Object.fromEntries(ctFormat.formatToParts(date).map((x) => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

// Regular-hours candles close every :00 and :30 from 9:00 AM through 3:00 PM CT.
const FIRST_CLOSE = 9 * 60; // 9:00 AM CT
const LAST_CLOSE = 15 * 60; // 3:00 PM CT
const CANDLE_MS = 30 * 60_000;
// Alerts only go out this long after a close; after that the signal is too late to act on.
const ALERT_WINDOW_MS = 5 * 60_000;
// How often to ask Massive whether the just-closed candle is published.
const POLL_MS = 1000;
// If the probe never sees the next candle start (a quiet tape), scan anyway after this long.
const MAX_PROBE_MS = 60_000;
// Rescans for tickers whose bar for the closed candle wasn't published yet on the first pass.
const RESCAN_MS = 10_000;
// A very liquid ticker whose next-candle bar showing up means the closed candle's trades are in.
const PROBE_TICKER = 'TSLA';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The :00 or :30 boundary nearest `now`: the upcoming close when fired at :29/:59, or the one
 *  that just passed if the scheduler or a cold start ran a few seconds late. */
function nearestCandleClose(now: Date): Date {
  return new Date(Math.round(now.getTime() / CANDLE_MS) * CANDLE_MS);
}

/**
 * Polls the probe ticker every POLL_MS until its bar for the candle opening at `closeMs` appears:
 * Massive builds bars from trades in order, so once the next candle has a bar, the closed one is
 * complete. Gives up after MAX_PROBE_MS and lets the scan run anyway.
 */
async function waitForCandle(closeMs: number): Promise<void> {
  const today = etParts(new Date(closeMs)).date;
  while (Date.now() < closeMs + MAX_PROBE_MS) {
    try {
      const bars = await getAggs30Min(PROBE_TICKER, today, today);
      if (bars.some((b) => Date.parse(b.time) >= closeMs)) return;
    } catch (err) {
      logger.warn('Candle probe failed', { error: (err as Error).message });
    }
    await sleep(POLL_MS);
  }
  logger.warn(`${PROBE_TICKER} showed no bar for the new candle within ${MAX_PROBE_MS / 1000}s; scanning anyway`);
}

// Twilio refuses a body over 1,600 characters; longer alerts go out as numbered parts.
const SMS_MAX = 1500;

export async function sendAlert(body: string): Promise<void> {
  const parts: string[] = [];
  let current = '';
  for (const line of body.split('\n').map((l) => l.slice(0, SMS_MAX))) {
    if (current && current.length + 1 + line.length > SMS_MAX) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  for (const [i, part] of parts.entries()) {
    await sendSms({
      accountSid: env('TWILIO_ACCOUNT_SID'),
      authToken: env('TWILIO_AUTH_TOKEN'),
      from: env('TWILIO_FROM_NUMBER'),
      to: env('ALERT_TO_NUMBER'),
      body: parts.length > 1 ? `(${i + 1}/${parts.length}) ${part}` : part,
    });
  }
}

/** Keeps the alerts whose doc in `collection` doesn't exist yet, i.e. not texted before. */
async function unsent<T>(collection: string, alerts: T[], docId: (alert: T) => string): Promise<T[]> {
  const refs = alerts.map((a) => db.collection(collection).doc(docId(a)));
  if (refs.length === 0) return [];
  const snaps = await db.getAll(...refs);
  return alerts.filter((_, i) => !snaps[i].exists);
}

// ---- Schwab auto-trading ----

// The dashboard's Auto-trading switch. Off stops every order this strategy places by itself (new
// entries, re-pricing them, take-profit sells, forced and expiration exits); signals still text.
// On unless it's been turned off, so deploying it changes nothing.
const TRADING_SWITCH = db.collection('settings').doc('trading');

async function switchOn(): Promise<boolean> {
  return (await TRADING_SWITCH.get()).get('autoTrading') !== false;
}

/** SCHWAB_TRADING=live in functions/.env, with the dashboard switch on, turns texting signals into placing orders. */
async function autoTrading(): Promise<boolean> {
  return process.env.SCHWAB_TRADING === 'live' && schwabConfigured() && (await switchOn());
}

interface TradingSwitchState {
  enabled: boolean;
  /** Whether SCHWAB_TRADING=live; when it isn't, nothing trades whatever the switch says. */
  envLive: boolean;
}

const switchState = async (): Promise<TradingSwitchState> => ({
  enabled: await switchOn(),
  envLive: process.env.SCHWAB_TRADING === 'live' && schwabConfigured(),
});

export interface BlockedSignal {
  candleTime: string | null;
  ticker: string;
  pass: string | null;
  price: number | null;
  reason: string;
  /** The filter readings the signal was judged on. */
  filters: Record<string, unknown> | null;
}

// liveEvents read to find them: the newest this many, which covers well over a week of scans.
const BLOCKED_SCAN_LIMIT = 2000;

/** Dashboard: MACD signals a filter or position rule blocked, newest first, from the last `days` days. */
export const getBlockedSignals = onCall<{ days?: number }>(async (request): Promise<BlockedSignal[]> => {
  requireSignIn(request);
  const days = Math.min(Math.max(Number(request.data?.days ?? 7), 1), 30);
  const since = new Date(Date.now() - days * 86_400_000);
  // Ordered by time only, so no composite index is needed; the type is filtered here.
  const snap = await db.collection(EVENTS_COLLECTION).orderBy('at', 'desc').limit(BLOCKED_SCAN_LIMIT).get();
  return snap.docs
    .filter((d) => d.get('type') === 'signal-skipped' && d.get('at')?.toDate() >= since)
    .map((d) => {
      const s = (d.get('signal') ?? {}) as Partial<EntrySignal>;
      return {
        candleTime: (d.get('candleTime') as string | undefined) ?? null,
        ticker: String(d.get('ticker') ?? s.ticker ?? ''),
        pass: (d.get('pass') as string | undefined) ?? null,
        price: s.price ?? null,
        reason: s.skipReason ?? String(d.get('text') ?? ''),
        filters: (s.filters as unknown as Record<string, unknown> | undefined) ?? null,
      };
    });
});

/** Dashboard: the Auto-trading switch's state. */
export const getAutoTrading = onCall(async (request): Promise<TradingSwitchState> => {
  requireSignIn(request);
  return switchState();
});

/** Dashboard: turns the Auto-trading switch on or off. */
export const setAutoTrading = onCall<{ enabled?: boolean }>(async (request): Promise<TradingSwitchState> => {
  requireSignIn(request);
  const enabled = request.data?.enabled;
  if (typeof enabled !== 'boolean') throw new HttpsError('invalid-argument', 'enabled must be true or false');
  await TRADING_SWITCH.set({ autoTrading: enabled, updatedAt: new Date(), updatedBy: request.auth?.token.email ?? null });
  logger.info(`Auto-trading switched ${enabled ? 'on' : 'off'}`);
  return switchState();
});

/** Atomically creates each item's doc; returns only the items this run created (won). */
async function claim<T extends object>(collection: string, items: T[], docId: (item: T) => string): Promise<T[]> {
  const won: T[] = [];
  for (const item of items) {
    try {
      await db.collection(collection).doc(docId(item)).create({ ...item, claimedAt: new Date() });
      won.push(item);
    } catch (err) {
      if ((err as { code?: number }).code !== 6) throw err; // 6 = ALREADY_EXISTS: an earlier pass has it
    }
  }
  return won;
}

/** Texts the reconnect link when Schwab's 7-day refresh token runs out within 36 hours. */
async function remindToReconnect(): Promise<void> {
  if (!schwabConfigured()) return;
  try {
    const expiresAt = await refreshExpiresAt();
    if (expiresAt && expiresAt - Date.now() > 36 * 60 * 60_000) return;
    const link = `${env('SCHWAB_CALLBACK_URL')}?connect=${env('SCHWAB_CONNECT_KEY')}`;
    const when = expiresAt ? new Date(expiresAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' CT' : 'now';
    await sendAlert(
      `Money Maker: Schwab connection ${expiresAt && expiresAt > Date.now() ? 'expires ' + when : 'has expired'}. Reconnect: ${link}`,
    );
  } catch (err) {
    logger.warn('Reconnect reminder failed', { error: (err as Error).message });
  }
}

/** Records the alerts as texted so a rescan of the same candle stays quiet. */
async function markSent<T extends object>(collection: string, alerts: T[], docId: (alert: T) => string): Promise<void> {
  const batch = db.batch();
  for (const a of alerts) batch.set(db.collection(collection).doc(docId(a)), { ...a, sentAt: new Date() });
  await batch.commit();
}

const money = (n: number) => `$${n.toFixed(2)}`;
function smsLine(s: EntrySignal): string {
  const exp = s.expiration.slice(5).replace('-', '/');
  const px = s.entryPrice ?? s.lastTradePrice ?? s.midpoint;
  const size = s.suggestedContracts != null ? `${s.suggestedContracts}x` : 'size at fill,';
  return (
    `${s.ticker} @ ${money(s.price)}: buy ${size} ${exp} $${s.strike}C ` +
    `${s.entryPrice != null ? '@' : '~'}${px != null ? money(px) : '?'}` +
    `${s.estimatedCost != null ? ` (${money(s.estimatedCost)})` : ''}. ` +
    `Trough ${s.troughValue.toFixed(2)}, RSI ${s.entryRsi.toFixed(1)}${s.boostRule >= 0 ? `, boosted ${(s.capPct * 100).toFixed(0)}% cap` : ''}`
  );
}

const entryAlertId = (s: EntrySignal) => `${s.ticker}_${s.candleTime}`;

// One doc per exit already texted, keyed by trade + candle. A trade you haven't closed yet is
// texted again at the next candle's close if it still meets an exit rule.
const EXIT_ALERTS_COLLECTION = 'exitAlerts';
const exitAlertId = (x: ExitCheck) => `${x.tradeId}_${x.candleTime}`;

const EXIT_LABELS: Record<NonNullable<ExitCheck['exitType']>, string> = {
  'take-profit': 'Take profit',
  forced: 'Forced exit',
  expiration: 'Expiration',
};

function exitSmsLine(x: ExitCheck): string {
  const exp = x.expiration.slice(5).replace('-', '/');
  const pnl = x.unrealizedPnl != null ? ` (${x.unrealizedPnl >= 0 ? '+' : '-'}${money(Math.abs(x.unrealizedPnl))})` : '';
  return (
    `${x.ticker} ${exp} $${x.strike}C x${x.contracts}: SELL ~${x.optionPrice != null ? money(x.optionPrice) : '?'}` +
    `, entry ${money(x.entryPrice)}${pnl}. ${EXIT_LABELS[x.exitType!]}: ${x.reasons[x.reasons.length - 1]}`
  );
}

interface AlertRun {
  /** Open time of the candle being judged. */
  candleTime: string;
  /** Judge the still-forming candle at live prices instead of the completed one (pre-close run). */
  preview: boolean;
  /** Whether orders may still be placed right now (checked after the scan, which takes a while). */
  canTrade: () => boolean;
  /** Why signals were only texted when canTrade() is false. */
  notTradedNote: string;
  execute: ExecuteOptions;
}

/** "10:30 AM-11:00 AM CT candle" for the candle opening at `candleTime`. */
function candleLabel(candleTime: string): string {
  const at = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
  const open = Date.parse(candleTime);
  return `${at(open)}-${at(open + CANDLE_MS)} CT candle`;
}

const signalFields = (s: EntrySignal) => ({ ticker: s.ticker, candleTime: s.candleTime, signal: s });
const exitFields = (x: ExitCheck) => ({ ticker: x.ticker, candleTime: x.candleTime, tradeId: x.tradeId, check: x });

/**
 * Runs the Look For Trades scan (entries on every ticker + exits on every open trade) on the
 * candle opening at `candleTime`. When auto-trading and run.canTrade(), places the entries and
 * forced / expiration exits; otherwise texts whatever qualifies that hasn't been texted yet.
 * Signals a filter blocked are texted too, and every signal, exit check and order is logged to
 * liveEvents. Returns the scan and how many tickers / open trades don't have that candle's bar yet.
 */
async function scanAndAlert(run: AlertRun): Promise<{ missing: number; result: ScanResult }> {
  const { candleTime, preview } = run;
  const pass = preview ? 'pre-close' : 'close';
  const live = await autoTrading();
  if (live) {
    // Size off Schwab's real cash: this checkpoints it into cashUpdates before the scan reads it.
    try {
      await syncBalances();
    } catch (err) {
      logger.warn('Schwab balance sync failed before scan', { error: (err as Error).message });
    }
  }
  const result = await scanForEntries(await loadAccountState(), { preview });
  const signals = result.signals.filter((s) => s.candleTime === candleTime);
  const entries = signals.filter((s) => !s.skipReason);
  const skipped = signals.filter((s) => s.skipReason);
  const checks = result.exits.filter((x) => x.status !== 'failed' && x.candleTime === candleTime);
  const exits = checks.filter((x) => x.status === 'exit');
  // Auto-trading, take profits rest as their own orders (entryOrders.ts): only forced / expiration exits sell or text here.
  const sells = live ? exits.filter((x) => x.exitType !== 'take-profit') : exits;
  const missing =
    result.entries.filter((e) => e.status !== 'failed' && e.candleTime !== candleTime).length +
    result.exits.filter((x) => x.status !== 'failed' && x.candleTime !== candleTime).length;
  logger.info('Alert scan', {
    candleTime,
    preview,
    signals: result.signals.length,
    entries: entries.map((s) => s.ticker),
    exits: exits.map((x) => x.ticker),
    missing,
    failed: result.failed,
  });

  // Log only: the scan, and every open trade's exit check (mid vs the take-profit, candles held).
  await logEvent({
    type: 'scan', candleTime, pass, live, scanned: result.scanned, missing, failed: result.failed,
    entries: entries.map((s) => s.ticker), skipped: skipped.map((s) => s.ticker), exits: exits.map((x) => x.ticker),
    openCount: result.openCount, cashAvailable: result.cashAvailable,
    text: `${candleLabel(candleTime)} ${pass} scan: ${entries.length} entries, ${skipped.length} skipped, ${exits.length} exits`,
  });
  await Promise.all(checks.map((x) =>
    logEvent({ type: 'exit-check', ...exitFields(x), pass, text: `${x.ticker} ${x.status}: ${x.reasons.join('; ')}` }, `exitcheck_${x.tradeId}_${candleTime}_${pass}`),
  ));

  // Signals a filter or position rule blocked: logged once per candle, never texted (too noisy).
  const lines: string[] = [];
  for (const s of skipped) {
    await logEvent({ type: 'signal-skipped', ...signalFields(s), pass, text: `${s.ticker} signal SKIPPED: ${s.skipReason}` }, `skip_${s.ticker}_${candleTime}`);
  }

  const header = `Money Maker, ${candleLabel(candleTime)} (${preview ? '5 min before its close, live prices' : 'at its close'})`;
  if (live && run.canTrade()) {
    // Claim first so a rescan of this candle can never place the same order twice.
    const claimedExits = await claim(EXIT_ALERTS_COLLECTION, sells, exitAlertId);
    const claimedEntries = await claim(ALERTS_COLLECTION, entries, entryAlertId);
    for (const x of claimedExits) await report(lines, { type: 'exit-signal', ...exitFields(x), pass, text: `EXIT ${exitSmsLine(x)}` });
    for (const s of claimedEntries) await report(lines, { type: 'signal', ...signalFields(s), pass, text: `ENTRY ${smsLine(s)}` });
    try {
      if (claimedExits.length) lines.push(...(await executeExits(claimedExits, run.execute)));
    } catch (err) {
      logger.error('Auto-trade exits failed', err);
      await report(lines, { type: 'error', candleTime, error: (err as Error).message, text: `Auto-trade exits FAILED: ${(err as Error).message.slice(0, 200)} - check Schwab, these may still be open` });
    }
    try {
      // Entries become limit orders re-priced every 5 minutes until they fill or 200 bars pass.
      if (claimedEntries.length) lines.push(...(await createPendingEntries(claimedEntries)));
    } catch (err) {
      logger.error('Auto-trade entries failed', err);
      await report(lines, { type: 'error', candleTime, error: (err as Error).message, text: `Auto-trade entries FAILED: ${(err as Error).message.slice(0, 200)} - not bought` });
    }
    if (lines.length) await sendAlert(`${header}:\n${lines.join('\n')}`);
    return { missing, result };
  }

  const [freshEntries, freshExits] = await Promise.all([
    unsent(ALERTS_COLLECTION, entries, entryAlertId),
    unsent(EXIT_ALERTS_COLLECTION, sells, exitAlertId),
  ]);
  // Auto-trading only gets here after the close, or when the early scan ran too long to trade.
  for (const x of freshExits) await logEvent({ type: live ? 'signal-missed' : 'exit-signal', ...exitFields(x), pass, traded: false, text: exitSmsLine(x) });
  for (const s of freshEntries) await logEvent({ type: live ? 'signal-missed' : 'signal', ...signalFields(s), pass, traded: false, text: smsLine(s) });
  lines.push(
    ...(freshExits.length ? [`Exit${freshExits.length > 1 ? 's' : ''}:`, ...freshExits.map(exitSmsLine)] : []),
    ...(freshEntries.length ? [`Entr${freshEntries.length > 1 ? 'ies' : 'y'}:`, ...freshEntries.map(smsLine)] : []),
  );
  if (lines.length) {
    const note = live && (freshExits.length || freshEntries.length) ? `\n(${run.notTradedNote})` : '';
    await sendAlert(`${header}:\n${lines.join('\n')}${note}`);
    await Promise.all([
      markSent(ALERTS_COLLECTION, freshEntries, entryAlertId),
      markSent(EXIT_ALERTS_COLLECTION, freshExits, exitAlertId),
    ]);
  }
  return { missing, result };
}

/**
 * After the close: entries bought on the 5-minutes-early look whose candle, now closed, doesn't
 * signal. The backtest judges the closed candle, so it wouldn't have taken them. Texted and logged.
 */
async function reportUnconfirmed(candleTime: string, result: ScanResult): Promise<void> {
  const bought = (await db.collection(ALERTS_COLLECTION).where('candleTime', '==', candleTime).get()).docs.filter((d) => d.get('claimedAt'));
  const lines: string[] = [];
  for (const d of bought) {
    const ticker = String(d.get('ticker'));
    const check = result.entries.find((e) => e.ticker === ticker);
    if (!check || check.candleTime !== candleTime || check.status === 'enter' || check.status === 'failed') continue;
    await report(lines, {
      type: 'signal-unconfirmed', ticker, candleTime, closeStatus: check.status, closePrice: check.price, reasons: check.reasons,
      text: `${ticker}: bought 5 min early, but the closed candle ${check.status === 'skip' ? 'skips it' : "doesn't signal"} ` +
        `(${check.reasons[0] ?? 'no reason given'}) - the backtest wouldn't have taken it`,
    });
  }
  if (lines.length) await sendAlert(`Money Maker, ${candleLabel(candleTime)} (at its close):\n${lines.join('\n')}`);
}

// Each candle is traded this long before its close (the backtest fills in a candle's last
// closeFillWindowMin minutes), and unfilled exits are canceled this long before it.
const PRE_CLOSE_MS = MACDEXP.closeFillWindowMin * 60_000;
const PRE_CLOSE_FILL_MARGIN_MS = 15_000;
// No new orders with less than this left before the close; there's no time for them to fill.
const PRE_CLOSE_MIN_ORDER_TIME_MS = 60_000;

/**
 * Every 30-min candle, 9:00 AM-3:00 PM CT closes on weekdays: 5 minutes before the close, judges
 * the still-forming candle at each ticker's live price - the backtest's rules, a few minutes
 * early - and places entries and forced exits at the mid while the candle's closing window is
 * still open, canceling unfilled exits 15s before the close (the next candle tries them again).
 * Entries keep working every 5 minutes after that (entryOrders.ts). On the day's last candle,
 * contracts whose exit is expiration are sold too, rather than left to settle overnight.
 */
export const closingTradesSchedule = onSchedule(
  {
    schedule: '24,54 8-14 * * 1-5',
    timeZone: 'America/Chicago',
    timeoutSeconds: 900,
    memory: '1GiB',
    maxInstances: 1,
    retryCount: 0,
  },
  async () => {
    const close = nearestCandleClose(new Date());
    const closeMinutes = ctMinutes(close);
    if (closeMinutes < FIRST_CLOSE || closeMinutes > LAST_CLOSE) return;
    const closeMs = close.getTime();
    if (closeMinutes === FIRST_CLOSE) await remindToReconnect();

    await sleep(Math.max(0, closeMs - PRE_CLOSE_MS - Date.now()));
    logger.info('Pre-close scan starting', { secondsBeforeClose: (closeMs - Date.now()) / 1000 });
    await scanAndAlert({
      candleTime: new Date(closeMs - CANDLE_MS).toISOString(),
      preview: true,
      canTrade: () => Date.now() < closeMs - PRE_CLOSE_MIN_ORDER_TIME_MS,
      notTradedNote: 'Scan finished too close to the close - not auto-traded.',
      execute: { fillBy: closeMs - PRE_CLOSE_FILL_MARGIN_MS, sellExpiring: closeMinutes === LAST_CLOSE },
    });
  },
);

/**
 * At each 30-min candle close, 9:00 AM-3:00 PM CT on weekdays: rejudges the candle on its actual
 * close. Cloud Scheduler can't fire more often than once a minute, so this starts a minute early
 * (:29/:59), sleeps until the close, polls every second until the closed candle is published,
 * then scans. Tickers whose bar was late are rescanned until ALERT_WINDOW_MS after the close.
 * Auto-trading, nothing is traded here - closingTradesSchedule already traded the candle 5
 * minutes early - but signals only the close shows are texted and logged as missed, and entries
 * the close doesn't confirm are texted and logged as unconfirmed. Not auto-trading, this texts
 * the signals as before.
 */
export const tradeAlertsSchedule = onSchedule(
  {
    schedule: '29,59 8-14 * * 1-5',
    timeZone: 'America/Chicago',
    // Up to ~2 min waiting for the candle, then ~1.5 min per scan, rescanning for up to 5 min.
    timeoutSeconds: 1800,
    memory: '1GiB',
    maxInstances: 1,
    retryCount: 0,
  },
  async () => {
    const close = nearestCandleClose(new Date());
    const closeMinutes = ctMinutes(close);
    if (closeMinutes < FIRST_CLOSE || closeMinutes > LAST_CLOSE) return;
    const closeMs = close.getTime();
    const candleTime = new Date(closeMs - CANDLE_MS).toISOString();
    const deadline = closeMs + ALERT_WINDOW_MS;

    await sleep(Math.max(0, closeMs - Date.now()));
    await waitForCandle(closeMs);
    logger.info('Candle published', { candleTime, secondsAfterClose: (Date.now() - closeMs) / 1000 });

    const run: AlertRun = {
      candleTime,
      preview: false,
      canTrade: () => false,
      notTradedNote: 'Seen only at the close, not 5 min before it - not auto-traded.',
      execute: {},
    };
    let last: ScanResult | undefined;
    while (Date.now() < deadline) {
      const { missing, result } = await scanAndAlert(run);
      last = result;
      if (missing === 0 || Date.now() + RESCAN_MS >= deadline) break;
      await sleep(RESCAN_MS);
    }
    if (last && (await autoTrading())) await reportUnconfirmed(candleTime, last);
  },
);

/**
 * Every 5 minutes through the session (9:30 AM-3:00 PM CT, weekdays): re-prices every entry still
 * waiting to fill to the latest mid, gives up on the ones whose 200 bars ran out, and keeps a
 * take-profit sell resting on every open trade. Texts and logs every order step.
 */
export const entryOrdersSchedule = onSchedule(
  { schedule: '*/5 8-14 * * 1-5', timeZone: 'America/Chicago', timeoutSeconds: 240, memory: '512MiB', maxInstances: 1, retryCount: 0 },
  async () => {
    if (!(await autoTrading())) return;
    const minutes = ctMinutes(new Date());
    if (minutes < 8 * 60 + 35 || minutes > 14 * 60 + 55) return;
    // Give the 5-minute bar that just closed a few seconds to be published.
    await sleep(15_000);
    try {
      const lines = await workOrders();
      if (lines.length) await sendAlert(`Money Maker orders:\n${lines.join('\n')}`);
    } catch (err) {
      logger.error('Entry / take-profit order step failed', err);
      const lines: string[] = [];
      await report(lines, { type: 'error', error: (err as Error).message, text: `Order step FAILED: ${(err as Error).message.slice(0, 200)} (tried again in 5 min)` });
      await sendAlert(`Money Maker orders:\n${lines.join('\n')}`).catch(() => undefined);
    }
  },
);

// ---- Fear & Greed (fetched from CNN each morning, or entered by hand) ----

/** The trading day whose close today's signals use: the last weekday before today. */
function previousWeekday(day: string): string {
  let d = addDays(day, -1);
  while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = addDays(d, -1);
  return d;
}

/** Dashboard: saves CNN's Fear & Greed close for a trading day. */
export const setFearGreed = onCall<{ date?: string; value?: number }>(async (request) => {
  requireSignIn(request);
  const { date, value } = request.data ?? {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpsError('invalid-argument', 'date must be YYYY-MM-DD');
  if (typeof value !== 'number' || !(value >= 0 && value <= 100)) throw new HttpsError('invalid-argument', 'value must be 0-100');
  await setFearGreedReading(date, Math.round(value * 100) / 100);
  return { date, value };
});

/** Dashboard: the latest readings and the date today's signals need. */
export const getFearGreed = onCall(async (request) => {
  requireSignIn(request);
  const fg = await loadFearGreed();
  const today = etParts(new Date()).date;
  const used = fearGreedBefore(fg, today);
  return {
    needed: previousWeekday(today),
    used: used ?? null,
    recent: fg.dates.slice(-10).map((date, i, all) => ({ date, value: fg.values[fg.values.length - all.length + i] })),
  };
});

/** 9 AM CT daily: fills in the previous days' Fear & Greed closes from CNN. The noon reminder covers a failure. */
export const fearGreedFetch = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'America/Chicago', retryCount: 0 },
  async () => {
    try {
      const added = await fillFearGreedFromCnn(etToday());
      logger.info('Fear & Greed fetched', { added });
    } catch (err) {
      logger.warn('Fear & Greed fetch failed - enter it on the dashboard', { error: (err as Error).message });
    }
  },
);

/** Noon CT on weekdays: texts a reminder when the previous trading day's Fear & Greed isn't entered. */
export const fearGreedReminder = onSchedule(
  { schedule: '0 12 * * 1-5', timeZone: 'America/Chicago', retryCount: 0 },
  async () => {
    const fg = await loadFearGreed();
    const needed = previousWeekday(etParts(new Date()).date);
    if (fg.dates.includes(needed)) return;
    const used = fearGreedBefore(fg, etParts(new Date()).date);
    await sendAlert(
      `Money Maker: Fear & Greed for ${needed} isn't entered. ` +
        (used ? `Signals are using ${used.date}'s ${used.value}.` : 'Signals are trading without the Fear & Greed filter.') +
        ' Enter it on the dashboard.',
    );
  },
);

// ---- IV series ----

/**
 * 4:30 PM CT on weekdays: adds today's implied vol (and any missed day in the last two weeks) to
 * every ticker's IV series, for tomorrow's IV-rank filter and IV-minus-realized-vol boost rule.
 */
export const ivSeriesSchedule = onSchedule(
  { schedule: '30 16 * * 1-5', timeZone: 'America/Chicago', timeoutSeconds: 1800, memory: '512MiB', maxInstances: 1, retryCount: 0 },
  async () => {
    const today = etToday();
    const excluded = new Set(MACDEXP.excludeTickers);
    const tickers = TICKERS.filter((t) => !excluded.has(t));
    let added = 0, failed = 0, next = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (next < tickers.length) {
          const ticker = tickers[next++];
          try {
            added += await updateIvSeries(ticker, today);
          } catch (err) {
            failed++;
            logger.warn(`${ticker}: IV series update failed`, { error: (err as Error).message });
          }
        }
      }),
    );
    logger.info('IV series updated', { today, added, failed });
    if (failed > tickers.length / 4) await sendAlert(`Money Maker: the nightly IV update failed for ${failed} of ${tickers.length} tickers.`);
  },
);
