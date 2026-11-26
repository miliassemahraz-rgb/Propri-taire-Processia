import {
  createParamDecorator,
  SetMetadata,
  type ArgumentMetadata,
  type ExecutionContext,
  type PipeTransform,
} from '@nestjs/common';
import { SESSION_COOKIE } from '@processia/contracts';
import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AuthError } from './errors.js';
import type { AuthContext } from './sessions.service.js';

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

/** Route sans session (connexion, acceptation d'invitation, santé). */
export const PUBLIC_KEY = 'processia:public';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** Route qui exige une session mais pas la double authentification (étapes de connexion, /me). */
export const SESSION_ONLY_KEY = 'processia:session-only';
export const SessionOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SESSION_ONLY_KEY, true);

/** Contexte d'authentification posé par la garde globale. */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
  if (auth === undefined) throw new AuthError('UNAUTHENTICATED');
  return auth;
});

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

/** Cookie de session : HttpOnly, Secure, SameSite=Strict, sans domaine (préfixe `__Host-`). */
export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
  });
}

export function originOf(req: Request): { ip: string | null; userAgent: string | null } {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

/** Valide le corps (ou un paramètre) avec un schéma zod du paquet `contracts`. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new AuthError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return parsed.data;
  }
}
