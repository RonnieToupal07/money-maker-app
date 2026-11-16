import { FirebaseOptions } from 'firebase/app';

// "Money Maker" web app in the money-maker-ronnie project. Web API keys only identify the
// project; access is enforced by Firestore security rules.
export const firebaseConfig: FirebaseOptions = {
  apiKey: 'AIzaSyBYBW4EbtWA32LXmR7UN2yoflg0dprmcbU',
  authDomain: 'money-maker-ronnie.firebaseapp.com',
  projectId: 'money-maker-ronnie',
  storageBucket: 'money-maker-ronnie.firebasestorage.app',
  messagingSenderId: '1091021107371',
  appId: '1:1091021107371:web:8d5b36e8d682208d9447ee',
};

export const TRADES_COLLECTION = 'trades';
export const CASH_UPDATES_COLLECTION = 'cashUpdates';
export const STARTING_ACCOUNT_VALUE = 2700;
// The trade log, cash and stats only count trades opened on or after this date.
// Keep in sync with LOG_START in functions/src/admin.ts.
export const LOG_START = '2026-10-15';
export const YEAR = '2026';
