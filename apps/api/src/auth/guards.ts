import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_HEADER, SESSION_COOKIE } from '@processia/contracts';
import { safeEqual } from './crypto.js';
import { AuthError } from './errors.js';
import { PUBLIC_KEY, readCookie, SESSION_ONLY_KEY, type AuthedRequest } from './http.js';
import { SessionsService } from './sessions.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Garde globale « session avec double authentification exigée ».
 *  1. `@Public()` : laisse passer.
 *  2. Pas de session valide : 401 `UNAUTHENTICATED`.
 *  3. Méthode non sûre : jeton CSRF synchronisé (`x-csrf-token`) exigé, sinon 403 `CSRF_INVALID`.
 *  4. Sauf `@SessionOnly()`, `mfa_verified_at` doit être renseigné, sinon 401 `MFA_REQUIRED`.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets) === true) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readCookie(request, SESSION_COOKIE);
    const auth = token === undefined ? null : await this.sessions.resolve(token);
    if (auth === null) throw new AuthError('UNAUTHENTICATED');

    if (!SAFE_METHODS.has(request.method.toUpperCase())) {
      const header = request.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !safeEqual(header, auth.csrfToken)) {
        throw new AuthError('CSRF_INVALID');
      }
    }
    const sessionOnly =
      this.reflector.getAllAndOverride<boolean | undefined>(SESSION_ONLY_KEY, targets) === true;
    if (!sessionOnly && auth.mfaVerifiedAt === null) throw new AuthError('MFA_REQUIRED');
    request.auth = auth;
    return true;
  }
}

export const RATE_LIMIT_OPTIONS = Symbol('RATE_LIMIT_OPTIONS');
export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}
export const DEFAULT_RATE_LIMIT: RateLimitOptions = { limit: 30, windowMs: 60_000 };

/**
 * Limitation de débit par adresse IP sur les routes d'authentification (mémoire du processus).
 * Elle complète le verrouillage par compte (6 échecs, 15 min). En production multi-instances, un
 * stockage partagé sera nécessaire (voir la dette dans WP-05.md).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();

  constructor(@Inject(RATE_LIMIT_OPTIONS) private readonly options: RateLimitOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const key = request.ip ?? 'unknown';
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.options.windowMs);
    if (recent.length >= this.options.limit) {
      this.hits.set(key, recent);
      throw new AuthError('RATE_LIMITED');
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((at) => now - at >= this.options.windowMs)) this.hits.delete(key);
    }
  }
}
