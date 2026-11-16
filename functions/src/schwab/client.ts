// Schwab Trader API (developer.schwab.com, "Accounts and Trading Production"). OAuth tokens live
// in Firestore at schwab/auth, which only the Admin SDK (these functions) should be able to read.
//
//   access token   30 minutes - refreshed automatically from the refresh token
//   refresh token  7 days     - Schwab doesn't extend it; reconnect through schwabAuth weekly
import { logger } from 'firebase-functions';
import { db } from '../admin.js';

const API = 'https://api.schwabapi.com';
const FETCH_TIMEOUT_MS = 30_000;
export const SCHWAB_COLLECTION = 'schwab';
const AUTH_DOC = db.collection(SCHWAB_COLLECTION).doc('auth');
const REFRESH_TOKEN_DAYS = 7;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in functions/.env`);
  return value;
}

export const schwabConfigured = () => !!(process.env.SCHWAB_APP_KEY && process.env.SCHWAB_APP_SECRET);

interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // ms
  refreshExpiresAt: number; // ms
  connectedAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const basic = Buffer.from(`${env('SCHWAB_APP_KEY')}:${env('SCHWAB_APP_SECRET')}`).toString('base64');
  const res = await fetch(`${API}/v1/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Schwab token error ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

/** The Schwab login page; it redirects back to SCHWAB_CALLBACK_URL with ?code=…&state=…. */
export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env('SCHWAB_APP_KEY'),
    redirect_uri: env('SCHWAB_CALLBACK_URL'),
    state,
  });
  return `${API}/v1/oauth/authorize?${params}`;
}

/** Trades the one-time authorization code for tokens and stores them; starts the 7-day clock. */
export async function exchangeCode(code: string): Promise<void> {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: env('SCHWAB_CALLBACK_URL') });
  const now = Date.now();
  const auth: StoredAuth = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    accessExpiresAt: now + t.expires_in * 1000,
    refreshExpiresAt: now + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
    connectedAt: now,
  };
  await AUTH_DOC.set(auth);
}

export async function refreshExpiresAt(): Promise<number | null> {
  const auth = (await AUTH_DOC.get()).data() as StoredAuth | undefined;
  return auth?.refreshExpiresAt ?? null;
}

/** A valid access token, refreshing it if it's within a minute of expiring. */
async function accessToken(): Promise<string> {
  const auth = (await AUTH_DOC.get()).data() as StoredAuth | undefined;
  if (!auth) throw new Error('Schwab is not connected yet - open the schwabAuth link to connect');
  if (auth.accessExpiresAt - 60_000 > Date.now()) return auth.accessToken;
  if (auth.refreshExpiresAt <= Date.now()) {
    throw new Error('Schwab refresh token expired (7-day limit) - open the schwabAuth link to reconnect');
  }
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
  await AUTH_DOC.update({
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? auth.refreshToken,
    accessExpiresAt: Date.now() + t.expires_in * 1000,
  });
  return t.access_token;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Schwab ${method} ${path} failed ${res.status}: ${await res.text()}`);
  return res;
}

const getJson = async <T>(path: string): Promise<T> => (await call('GET', path)).json() as Promise<T>;

// ---- Accounts ----

/**
 * The encrypted account id ("hashValue") Schwab wants in every account URL, for the account
 * number in `account`, else SCHWAB_ACCOUNT_NUMBER (or the only linked account if that's unset).
 */
/** The account numbers linked to this app's Schwab login. */
export async function linkedAccountNumbers(): Promise<string[]> {
  return (await getJson<{ accountNumber: string }[]>('/trader/v1/accounts/accountNumbers')).map((a) => a.accountNumber);
}

const cachedHashes = new Map<string, string>();
async function accountHash(account?: string): Promise<string> {
  const wanted = account ?? process.env.SCHWAB_ACCOUNT_NUMBER;
  const cached = cachedHashes.get(wanted ?? '');
  if (cached) return cached;
  const accounts = await getJson<{ accountNumber: string; hashValue: string }[]>('/trader/v1/accounts/accountNumbers');
  const match = wanted ? accounts.find((a) => a.accountNumber === wanted) : accounts.length === 1 ? accounts[0] : undefined;
  if (!match) {
    throw new Error(
      wanted
        ? `Schwab account ${wanted} isn't linked to this app`
        : `${accounts.length} Schwab accounts are linked - set SCHWAB_ACCOUNT_NUMBER in functions/.env`,
    );
  }
  cachedHashes.set(wanted ?? '', match.hashValue);
  return match.hashValue;
}

export interface SchwabPosition {
  symbol: string; // e.g. "TSLA  261023C00400000"
  assetType: string;
  description: string;
  longQuantity: number;
  shortQuantity: number;
  averagePrice: number; // per share, i.e. the option premium as quoted
  marketValue: number;
  /** Unrealized P&L on the long side, as Schwab reports it; null if it doesn't. */
  openProfitLoss: number | null;
  dayProfitLoss: number | null;
  /** Schwab's margin requirement for this position right now; null if it doesn't report one. */
  maintenanceRequirement: number | null;
}

export interface SchwabBalances {
  accountType: string; // CASH or MARGIN
  /** What can be spent on a long option right now. */
  cashAvailable: number;
  /** Schwab's margin room for new positions; null if it doesn't report one. */
  availableFunds: number | null;
  /** Net liquidation value of the whole account. */
  accountValue: number;
  positions: SchwabPosition[];
}

interface AccountResponse {
  securitiesAccount: {
    type: string;
    positions?: Array<{
      longQuantity: number;
      shortQuantity?: number;
      averagePrice: number;
      marketValue: number;
      longOpenProfitLoss?: number;
      currentDayProfitLoss?: number;
      maintenanceRequirement?: number;
      instrument: { symbol: string; assetType: string; description?: string };
    }>;
    currentBalances: Record<string, number | undefined>;
  };
}

export async function getBalances(account?: string): Promise<SchwabBalances> {
  const { securitiesAccount: a } = await getJson<AccountResponse>(`/trader/v1/accounts/${await accountHash(account)}?fields=positions`);
  const b = a.currentBalances;
  // Long options must be paid in full even in a margin account, so use non-marginable buying power there.
  const cashAvailable =
    a.type === 'CASH'
      ? b.cashAvailableForTrading ?? b.cashBalance ?? 0
      : b.buyingPowerNonMarginableTrade ?? b.availableFunds ?? b.cashBalance ?? 0;
  return {
    accountType: a.type,
    cashAvailable,
    availableFunds: b.availableFunds ?? null,
    accountValue: b.liquidationValue ?? b.equity ?? 0,
    positions: (a.positions ?? []).map((p) => ({
      symbol: p.instrument.symbol,
      assetType: p.instrument.assetType,
      description: p.instrument.description ?? '',
      longQuantity: p.longQuantity,
      shortQuantity: p.shortQuantity ?? 0,
      averagePrice: p.averagePrice,
      marketValue: p.marketValue,
      openProfitLoss: p.longOpenProfitLoss ?? null,
      dayProfitLoss: p.currentDayProfitLoss ?? null,
      maintenanceRequirement: p.maintenanceRequirement ?? null,
    })),
  };
}

// ---- Orders ----

export interface OrderRequest {
  instruction: 'BUY_TO_OPEN' | 'SELL_TO_CLOSE' | 'SELL_TO_OPEN' | 'BUY_TO_CLOSE';
  symbol: string;
  quantity: number;
  limitPrice: number;
  /** DAY (default) expires at the close; GOOD_TILL_CANCEL rests until filled or canceled. */
  duration?: 'DAY' | 'GOOD_TILL_CANCEL';
}

const orderBody = (o: OrderRequest) => ({
  orderType: 'LIMIT',
  session: 'NORMAL',
  duration: o.duration ?? 'DAY',
  price: o.limitPrice.toFixed(2),
  orderStrategyType: 'SINGLE',
  orderLegCollection: [
    { instruction: o.instruction, quantity: o.quantity, instrument: { symbol: o.symbol, assetType: 'OPTION' } },
  ],
});

// 201 Created with no body; the new order's id is the last segment of the Location header.
function orderIdFrom(res: Response): string {
  const id = res.headers.get('location')?.split('/').pop();
  if (!id) throw new Error('Schwab accepted the order but returned no order id');
  return id;
}

/** Places a single-leg limit order for an option; returns Schwab's order id. */
export async function placeOrder(o: OrderRequest, account?: string): Promise<string> {
  return orderIdFrom(await call('POST', `/trader/v1/accounts/${await accountHash(account)}/orders`, orderBody(o)));
}

export interface OrderStatus {
  status: string; // WORKING, FILLED, CANCELED, REJECTED, EXPIRED, ...
  /** Schwab's explanation, e.g. why an order was rejected; null when it gives none. */
  statusDescription: string | null;
  quantity: number;
  filledQuantity: number;
  /** Quantity-weighted fill price, or null before any fill. */
  avgFillPrice: number | null;
  lastFillTime: string | null;
}

interface OrderResponse {
  orderId: number;
  status: string;
  statusDescription?: string;
  enteredTime?: string;
  closeTime?: string;
  quantity: number;
  filledQuantity: number;
  orderLegCollection?: Array<{ instruction: string; quantity: number; instrument: { assetType: string; symbol: string } }>;
  orderActivityCollection?: Array<{ executionLegs?: Array<{ quantity: number; price: number; time: string }> }>;
}

function toStatus(o: OrderResponse): OrderStatus {
  const legs = (o.orderActivityCollection ?? []).flatMap((a) => a.executionLegs ?? []);
  const qty = legs.reduce((sum, l) => sum + l.quantity, 0);
  return {
    status: o.status,
    statusDescription: o.statusDescription || null,
    quantity: o.quantity,
    filledQuantity: o.filledQuantity,
    avgFillPrice: qty ? legs.reduce((sum, l) => sum + l.price * l.quantity, 0) / qty : null,
    lastFillTime: legs.length ? legs.map((l) => l.time).sort()[legs.length - 1] : null,
  };
}

export async function getOrder(orderId: string, account?: string): Promise<OrderStatus> {
  return toStatus(await getJson<OrderResponse>(`/trader/v1/accounts/${await accountHash(account)}/orders/${orderId}`));
}

/** A single-leg option order with at least one fill, as listed by getFilledOptionOrders. */
export interface FilledOptionOrder extends OrderStatus {
  orderId: string;
  instruction: string; // BUY_TO_OPEN, SELL_TO_CLOSE, SELL_TO_OPEN, BUY_TO_CLOSE
  symbol: string; // e.g. "TSLA  261023C00400000"
  fillTime: string;
}

/**
 * Every single-leg option order entered in [from, to] that has filled, fully or partly, and is
 * finished (a still-working order is picked up once it's done), in `account` (else
 * SCHWAB_ACCOUNT_NUMBER). Schwab allows up to 60 days back.
 */
export async function getFilledOptionOrders(from: Date, to: Date, account?: string): Promise<FilledOptionOrder[]> {
  const params = new URLSearchParams({ fromEnteredTime: from.toISOString(), toEnteredTime: to.toISOString(), maxResults: '3000' });
  const orders = await getJson<OrderResponse[]>(`/trader/v1/accounts/${await accountHash(account)}/orders?${params}`);
  const finished = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'REPLACED']);
  return orders.flatMap((o) => {
    const leg = o.orderLegCollection?.length === 1 ? o.orderLegCollection[0] : undefined;
    if (!leg || leg.instrument.assetType !== 'OPTION' || !o.filledQuantity || !finished.has(o.status)) return [];
    const status = toStatus(o);
    if (status.avgFillPrice == null) return [];
    return [{
      ...status,
      orderId: String(o.orderId),
      instruction: leg.instruction,
      symbol: leg.instrument.symbol,
      fillTime: status.lastFillTime ?? o.closeTime ?? o.enteredTime ?? new Date().toISOString(),
    }];
  });
}

export async function cancelOrder(orderId: string, account?: string): Promise<void> {
  try {
    await call('DELETE', `/trader/v1/accounts/${await accountHash(account)}/orders/${orderId}`);
  } catch (err) {
    // Usually means it filled or was already canceled in the meantime; the caller re-reads it.
    logger.warn(`Couldn't cancel Schwab order ${orderId}`, { error: (err as Error).message });
  }
}

/** Schwab's option symbol: root padded to 6, YYMMDD, C/P, strike x1000 in 8 digits. */
export function schwabOptionSymbol(ticker: string, expiration: string, strike: number, putCall: 'C' | 'P' = 'C'): string {
  const yymmdd = expiration.slice(2, 10).replaceAll('-', '');
  return `${ticker.padEnd(6, ' ')}${yymmdd}${putCall}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}
