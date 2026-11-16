import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';

// Inside Cloud Functions the Admin SDK picks up the project (money-maker-ronnie) and
// credentials automatically, and bypasses Firestore security rules.
initializeApp();

export const db = getFirestore();

// Keep in sync with src/app/firebase.config.ts in the Angular app.
export const TRADES_COLLECTION = 'trades';
export const CASH_UPDATES_COLLECTION = 'cashUpdates';
export const STARTING_ACCOUNT_VALUE = 2700;
// The trade log, cash and open positions only count trades opened on or after this date.
export const LOG_START = '2026-10-15';

/** Callables only answer signed-in users (accounts are added in the Firebase console's Authentication tab). */
export function requireSignIn(request: CallableRequest<unknown>): void {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
}
