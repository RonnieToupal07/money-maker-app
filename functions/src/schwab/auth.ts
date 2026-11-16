// Connects (and weekly, reconnects) the Schwab account. Register this function's URL as the
// app's Callback URL on developer.schwab.com and in SCHWAB_CALLBACK_URL.
//
//   1. Open  <callback url>?connect=<SCHWAB_CONNECT_KEY>   (bookmark it)
//   2. Log in to Schwab, pick the account, allow access
//   3. Schwab redirects back here with ?code=…&state=… and the tokens are saved
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { logger } from 'firebase-functions';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { db, requireSignIn } from '../admin.js';
import { SCHWAB_COLLECTION, authorizeUrl, exchangeCode, schwabConfigured } from './client.js';
import { syncBalances } from './sync.js';

const STATES = db.collection(SCHWAB_COLLECTION).doc('auth').collection('pendingStates');
const STATE_TTL_MS = 10 * 60_000;

function matchesConnectKey(given: string): boolean {
  const expected = process.env.SCHWAB_CONNECT_KEY ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return expected.length >= 16 && a.length === b.length && timingSafeEqual(a, b);
}

const page = (title: string, body: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:520px;margin:40px auto;padding:0 16px"><h1>${title}</h1><p>${body}</p></body>`;

/** A Schwab login URL with a fresh saved state, which the callback below checks. */
async function startLogin(): Promise<string> {
  const nonce = randomBytes(24).toString('hex');
  await STATES.doc(nonce).set({ createdAt: Date.now() });
  return authorizeUrl(nonce);
}

/** Dashboard "Reconnect" button: signing in stands in for the connect key, which stays on the server. */
export const schwabConnectUrl = onCall(async (request): Promise<{ url: string }> => {
  requireSignIn(request);
  if (!schwabConfigured()) throw new HttpsError('failed-precondition', 'Schwab is not set up in functions/.env');
  return { url: await startLogin() };
});

export const schwabAuth = onRequest(async (req, res) => {
  const { connect, code, state } = req.query as Record<string, string | undefined>;

  if (connect) {
    // Only someone with SCHWAB_CONNECT_KEY can start a login, so nobody else can link their
    // own Schwab account in place of yours.
    if (!matchesConnectKey(connect)) {
      res.status(403).send(page('Not allowed', 'That connect key is wrong.'));
      return;
    }
    res.redirect(await startLogin());
    return;
  }

  if (code) {
    const stateDoc = state ? await STATES.doc(state).get() : null;
    if (!stateDoc?.exists || Date.now() - stateDoc.get('createdAt') > STATE_TTL_MS) {
      res.status(400).send(page('Link expired', 'Start again from your connect link.'));
      return;
    }
    await stateDoc.ref.delete();
    try {
      await exchangeCode(code);
      const balances = await syncBalances();
      res.send(
        page(
          'Schwab connected',
          `Cash available $${balances.cashAvailable.toFixed(2)}, account value $${balances.accountValue.toFixed(2)}. ` +
            'The connection lasts 7 days; you will get a text the day before it needs reconnecting.',
        ),
      );
    } catch (err) {
      logger.error('Schwab connect failed', err);
      res.status(500).send(page('Connect failed', String((err as Error).message)));
    }
    return;
  }

  res.status(404).send(page('Not found', ''));
});
