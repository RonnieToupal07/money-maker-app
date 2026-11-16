import { Routes } from '@angular/router';
import { authGuard, loginGuard } from './auth/auth.guard';

export const routes: Routes = [
  { path: 'login', canActivate: [loginGuard], loadComponent: () => import('./auth/login').then((m) => m.Login) },
  { path: '', canActivate: [authGuard], loadComponent: () => import('./dashboard/dashboard').then((m) => m.Dashboard) },
  {
    path: 'look-for-trades',
    canActivate: [authGuard],
    loadComponent: () => import('./look-for-trades/look-for-trades').then((m) => m.LookForTrades),
  },
  {
    path: 'bx-trades',
    canActivate: [authGuard],
    loadComponent: () => import('./bx-trades/bx-trades').then((m) => m.BxTrades),
  },
  { path: '**', redirectTo: '' },
];
