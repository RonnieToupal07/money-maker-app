import { Component, ElementRef, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './auth/auth.service';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  selector: 'app-root',
  template: `
    @if (auth.user(); as user) {
      <div class="shell">
        <nav class="app-tabs" aria-label="Sections">
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page">30-min Buy Short-Term Calls</a>
          <a routerLink="/bx-trades" routerLinkActive="active" ariaCurrentWhenActive="page">Selling Naked Options</a>
        </nav>
        <div class="account">
          <button
            class="avatar"
            type="button"
            aria-label="Account"
            aria-haspopup="menu"
            [attr.aria-expanded]="menuOpen()"
            (click)="menuOpen.set(!menuOpen())"
          >
            <img src="favicon-128.png" alt="" width="36" height="36" />
          </button>
          @if (menuOpen()) {
            <div class="menu" role="menu">
              <span class="email">{{ user.email }}</span>
              <button type="button" role="menuitem" (click)="auth.signOut()">Log out</button>
            </div>
          }
        </div>
      </div>
    }
    <router-outlet />
  `,
  host: { '(document:click)': 'closeMenu($event)', '(document:keydown.escape)': 'menuOpen.set(false)' },
  styles: `
    .shell {
      max-width: 1140px; margin: 0 auto 18px;
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
    }
    .account { position: relative; margin-left: auto; }
    .avatar {
      display: block; padding: 0; border: 2px solid var(--hairline); border-radius: 50%;
      background: none; cursor: pointer; overflow: hidden; width: 40px; height: 40px;
    }
    .avatar:hover, .avatar[aria-expanded='true'] { border-color: var(--accent); }
    .avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .menu {
      position: absolute; right: 0; top: calc(100% + 6px); z-index: 20;
      display: flex; flex-direction: column; gap: 8px; min-width: 200px;
      padding: 12px 14px;
      background: var(--surface); border: 1px solid var(--hairline); border-radius: 10px;
      box-shadow: 0 6px 20px rgb(0 0 0 / 0.12);
    }
    .email { font-size: 12.5px; color: var(--ink-muted); overflow-wrap: anywhere; }
    .menu button {
      font: inherit; font-size: 13px; font-weight: 600; text-align: left; color: var(--loss);
      background: none; border: 0; padding: 0; cursor: pointer;
    }
    .menu button:hover { text-decoration: underline; }
    .app-tabs {
      display: flex;
      gap: 4px;
      padding: 3px;
      width: fit-content;
      max-width: 100%;
      background: var(--surface-2);
      border: 1px solid var(--hairline);
      border-radius: 9px;
    }
    a {
      font-size: 13px;
      font-weight: 600;
      padding: 6px 14px;
      border-radius: 7px;
      color: var(--ink-muted);
      text-decoration: none;
      text-align: center;
    }
    a:hover { color: var(--ink); }
    a.active { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); }
  `,
})
export class App {
  protected readonly auth = inject(AuthService);
  protected readonly menuOpen = signal(false);
  private readonly host = inject(ElementRef<HTMLElement>);

  protected closeMenu(event: Event): void {
    if (!this.host.nativeElement.querySelector('.account')?.contains(event.target as Node)) this.menuOpen.set(false);
  }
}
