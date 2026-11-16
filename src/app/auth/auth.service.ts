import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { getApps, initializeApp } from 'firebase/app';
import { User, browserLocalPersistence, getAuth, onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { firebaseConfig } from '../firebase.config';

// Sign-ins last until midnight Central: a sign-in from an earlier day is signed out.
const TIME_ZONE = 'America/Chicago';
const dayOf = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });

/**
 * Firebase Auth email/password sign-in, limited to accounts that already exist in the project
 * (added in the Firebase console). The session is kept in local storage, so a refresh stays signed in.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly user = signal<User | null>(null);

  private readonly router = inject(Router);
  private readonly auth = getAuth(getApps()[0] ?? initializeApp(firebaseConfig));
  /** Resolves once Firebase has restored (or not) the saved session. */
  readonly ready: Promise<void>;

  constructor() {
    void setPersistence(this.auth, browserLocalPersistence);
    this.ready = new Promise((resolve) => {
      onAuthStateChanged(this.auth, async (user) => {
        if (user) await this.measureClockSkew(user);
        if (user && this.expired(user)) {
          void this.signOut();
        } else {
          this.user.set(user);
          // Signed out anywhere (another tab, a revoked account): go to the login page.
          if (!user && !location.pathname.startsWith('/login')) {
            void this.router.navigate(['/login'], { queryParams: { next: location.pathname } });
          }
        }
        resolve();
      });
    });
    // A tab left open overnight signs out at midnight, or when it's next looked at.
    setInterval(() => this.checkExpiry(), 60_000);
    document.addEventListener('visibilitychange', () => this.checkExpiry());
  }

  async signIn(email: string, password: string): Promise<void> {
    await setPersistence(this.auth, browserLocalPersistence);
    const { user } = await signInWithEmailAndPassword(this.auth, email.trim(), password);
    this.user.set(user);
  }

  /** Signs out and reloads to the login page, dropping every listener and cached value. */
  async signOut(): Promise<void> {
    await signOut(this.auth);
    location.assign('/login');
  }

  /**
   * Firebase's clock minus this device's, in ms. The sign-in time comes from Firebase, so "today" has
   * to as well: a device clock set to the wrong day would otherwise sign out every sign-in at once.
   */
  private skewMs = 0;

  private async measureClockSkew(user: User): Promise<void> {
    try {
      const before = Date.now();
      const { issuedAtTime } = await user.getIdTokenResult(true);
      // Token times are whole seconds; anything under a few minutes is just rounding and latency.
      const skew = Date.parse(issuedAtTime) - (before + Date.now()) / 2;
      this.skewMs = Math.abs(skew) > 5 * 60_000 ? skew : 0;
      if (this.skewMs) console.warn(`This device's clock is off by ${Math.round(-this.skewMs / 3_600_000)} h; using Firebase's time for the daily sign-out.`);
    } catch {
      // Offline or the token couldn't refresh: fall back to the device clock.
    }
  }

  private expired(user: User): boolean {
    const at = user.metadata.lastSignInTime;
    return !at || dayOf(new Date(at)) !== dayOf(new Date(Date.now() + this.skewMs));
  }

  private checkExpiry(): void {
    const user = this.user();
    if (user && this.expired(user)) void this.signOut();
  }
}
