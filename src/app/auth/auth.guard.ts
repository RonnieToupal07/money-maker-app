import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** Pages behind the login: sends signed-out visitors to /login, then back here after signing in. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  await auth.ready;
  return auth.user() ? true : inject(Router).createUrlTree(['/login'], { queryParams: { next: state.url } });
};

/** The login page itself: already signed in goes straight to the dashboard. */
export const loginGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  await auth.ready;
  return auth.user() ? inject(Router).createUrlTree(['/']) : true;
};
