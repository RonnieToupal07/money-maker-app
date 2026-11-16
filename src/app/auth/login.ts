import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { FirebaseError } from 'firebase/app';
import { AuthService } from './auth.service';

/** Sign-in for accounts that exist in the project's Firebase Auth. There's no sign-up. */
@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule],
  template: `
    <main class="login">
      <form class="card" [formGroup]="form" (ngSubmit)="submit()">
        <img src="favicon-128.png" alt="" width="72" height="72" />
        <h1>Money Maker</h1>
        <p class="note">Sign in with your account. Sessions end at midnight Central.</p>

        <label>
          <span>Email</span>
          <input type="email" autocomplete="username" formControlName="email" />
        </label>
        <label>
          <span>Password</span>
          <input type="password" autocomplete="current-password" formControlName="password" />
        </label>

        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }

        <button class="btn primary" type="submit" [disabled]="form.invalid || busy()">
          {{ busy() ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </main>
  `,
  styles: `
    .login { min-height: 80vh; display: grid; place-items: center; padding: 16px; }
    .card {
      width: min(360px, 100%);
      display: flex; flex-direction: column; gap: 12px;
      padding: 28px 24px;
      background: var(--surface);
      border: 1px solid var(--hairline);
      border-radius: 12px;
    }
    img { align-self: center; border-radius: 50%; }
    h1 { font-family: var(--font-display); font-size: 22px; font-weight: 600; margin: 0; text-align: center; }
    .note { font-size: 12.5px; color: var(--ink-muted); margin: 0 0 4px; text-align: center; }
    label { display: flex; flex-direction: column; gap: 4px; }
    label span { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); }
    input {
      font: inherit; font-size: 14px; padding: 8px 10px;
      border: 1px solid var(--hairline); border-radius: 7px; background: var(--surface); color: var(--ink);
    }
    input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    .error { color: var(--loss); background: var(--loss-bg); font-size: 12.5px; padding: 8px 10px; border-radius: 7px; margin: 0; }
    button { margin-top: 6px; }
  `,
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    password: new FormControl('', { nonNullable: true, validators: Validators.required }),
  });

  /** Firebase's reason in plain words, with its code so an unfamiliar one can still be looked up. */
  private signInError(err: unknown): string {
    const code = err instanceof FirebaseError ? err.code : '';
    switch (code) {
      case 'auth/invalid-credential':
      case 'auth/invalid-login-credentials':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
        return 'Firebase says the email or password is incorrect. If your browser filled the password in, type it by hand - it may be the old one.';
      case 'auth/too-many-requests':
        return 'Firebase has paused sign-ins for this account after too many attempts. Wait 15-30 minutes, or reset the password to unlock it right away.';
      case 'auth/user-disabled':
        return 'This account is disabled in Firebase Authentication.';
      case 'auth/network-request-failed':
        return "Couldn't reach Firebase. Check your connection, or turn off an ad or privacy blocker for this site.";
      case 'auth/operation-not-allowed':
        return 'Email/password sign-in is turned off in the Firebase console (Authentication → Sign-in method).';
      default:
        return `Sign-in failed (${code || (err instanceof Error ? err.message : String(err))}).`;
    }
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) return;
    this.busy.set(true);
    this.error.set(null);
    const { email, password } = this.form.getRawValue();
    try {
      await this.auth.signIn(email, password);
    } catch (err) {
      console.error('Sign-in failed', err);
      this.error.set(this.signInError(err));
      this.busy.set(false);
      return;
    }
    // Signed in; anything that fails from here is the app, not the password.
    try {
      const next = this.route.snapshot.queryParamMap.get('next');
      await this.router.navigateByUrl(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      console.error('Opening the app after sign-in failed', err);
      this.error.set(`Signed in, but the app failed to open: ${err instanceof Error ? err.message : String(err)}. Try reloading the page.`);
    } finally {
      this.busy.set(false);
    }
  }
}
