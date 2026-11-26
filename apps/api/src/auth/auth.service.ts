import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import {
  RECOVERY_CODE_COUNT,
  type LoginResponse,
  type MeResponse,
  type MeUser,
} from '@processia/contracts';
import { recoveryCodes, users, type Database } from '@processia/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import { ENV } from '../env.js';
import { hmacBase64url } from './crypto.js';
import { AuthError } from './errors.js';
import { PasswordService } from './passwords.js';
import { AuditService, CLOCK, TotpService, type Clock } from './services.js';
import {
  SessionsService,
  type AuthContext,
  type CreatedSession,
  type SessionOrigin,
  type UserRow,
} from './sessions.service.js';

/** Échecs consécutifs (mot de passe ou second facteur) qui verrouillent le compte (6 : spéc. 3.4). */
export const MAX_FAILED_ATTEMPTS = 6;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface Origin extends SessionOrigin {
  ip?: string | null;
}

function toMeUser(user: UserRow): MeUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    globalRole: user.globalRole as MeUser['globalRole'],
  };
}

function generateRecoveryCode(): string {
  const pick = (): string => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)] ?? 'A';
  const part = (): string => Array.from({ length: 5 }, pick).join('');
  return `${part()}-${part()}`;
}

function normalizeRecoveryCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 10 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : raw;
}

@Injectable()
export class AuthService {
  /** Haché fictif : égalise le temps de réponse quand l'adresse est inconnue. */
  private dummyHash: Promise<string> | undefined;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ----- Connexion : premier facteur -----

  async login(
    email: string,
    password: string,
    origin: Origin,
    previousSessionId?: string,
  ): Promise<{ session: CreatedSession; response: LoginResponse }> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (user === undefined || user.status !== 'active' || user.passwordHash === null) {
      this.dummyHash ??= this.passwords.hash('processia-dummy-password');
      await this.passwords.verify(await this.dummyHash, password);
      await this.audit.record({
        action: 'auth.login_failed',
        target: 'user:unknown',
        payload: { email: email.toLowerCase(), reason: 'unknown_or_inactive' },
        ip: origin.ip ?? null,
      });
      throw new AuthError('INVALID_CREDENTIALS');
    }
    this.assertNotLocked(user);
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      await this.registerFailure(user, 'password', origin);
    }
    if (previousSessionId !== undefined) await this.sessions.destroy(previousSessionId);
    const session = await this.sessions.create(user.id, { mfaVerified: false, ...origin });
    await this.audit.record({
      actorId: user.id,
      action: 'auth.login_succeeded',
      target: `user:${user.id}`,
      payload: { mfa: 'pending' },
      ip: origin.ip ?? null,
    });
    return {
      session,
      response: {
        next: user.totpEnabledAt === null ? 'mfa_enroll' : 'mfa_verify',
        csrfToken: session.csrfToken,
      },
    };
  }

  // ----- Second facteur -----

  async verifyTotp(
    auth: AuthContext,
    code: string,
    origin: Origin,
  ): Promise<{ session: CreatedSession; csrfToken: string; user: MeUser }> {
    const user = await this.freshUser(auth.userId);
    this.assertNotLocked(user);
    if (user.totpEnabledAt === null || user.totpSecretEnc === null) {
      throw new AuthError('MFA_NOT_ENROLLED');
    }
    if (!(await this.acceptTotp(user, code))) {
      await this.registerFailure(user, 'totp', origin);
    }
    return this.openSession(auth, user, 'auth.mfa_verified', origin);
  }

  async enroll(auth: AuthContext): Promise<{ secret: string; uri: string; qr: string }> {
    const user = await this.freshUser(auth.userId);
    if (user.totpEnabledAt !== null) throw new AuthError('MFA_ALREADY_ENROLLED');
    const secret = this.totp.newSecret();
    await this.db
      .update(users)
      .set({ totpSecretEnc: this.totp.encrypt(secret), totpLastStep: null })
      .where(eq(users.id, user.id));
    const uri = this.totp.otpauthUri(secret, user.email);
    return { secret, uri, qr: await this.totp.qrCodeDataUrl(uri) };
  }

  async confirmEnrollment(
    auth: AuthContext,
    code: string,
    origin: Origin,
  ): Promise<{
    session: CreatedSession;
    csrfToken: string;
    user: MeUser;
    recoveryCodes: string[];
  }> {
    const user = await this.freshUser(auth.userId);
    this.assertNotLocked(user);
    if (user.totpEnabledAt !== null) throw new AuthError('MFA_ALREADY_ENROLLED');
    if (user.totpSecretEnc === null) throw new AuthError('MFA_NOT_ENROLLED');
    if (!(await this.acceptTotp(user, code))) {
      await this.registerFailure(user, 'totp', origin);
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ totpEnabledAt: this.clock.now() }).where(eq(users.id, user.id));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
      await tx
        .insert(recoveryCodes)
        .values(codes.map((c) => ({ userId: user.id, codeHash: this.recoveryHash(c) })));
    });
    await this.audit.record({
      actorId: user.id,
      action: 'auth.mfa_enrolled',
      target: `user:${user.id}`,
      ip: origin.ip ?? null,
    });
    const opened = await this.openSession(auth, user, 'auth.mfa_verified', origin);
    return { ...opened, recoveryCodes: codes };
  }

  async useRecoveryCode(
    auth: AuthContext,
    code: string,
    origin: Origin,
  ): Promise<{
    session: CreatedSession;
    csrfToken: string;
    user: MeUser;
    remainingRecoveryCodes: number;
  }> {
    const user = await this.freshUser(auth.userId);
    this.assertNotLocked(user);
    if (user.totpEnabledAt === null) throw new AuthError('MFA_NOT_ENROLLED');
    // Usage unique : la ligne n'est « consommée » que par une mise à jour atomique.
    const claimed = await this.db
      .update(recoveryCodes)
      .set({ usedAt: this.clock.now() })
      .where(
        and(
          eq(recoveryCodes.userId, user.id),
          eq(recoveryCodes.codeHash, this.recoveryHash(normalizeRecoveryCode(code))),
          isNull(recoveryCodes.usedAt),
        ),
      )
      .returning({ id: recoveryCodes.id });
    if (claimed.length === 0) {
      await this.registerFailure(user, 'recovery', origin);
    }
    const [remaining] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, user.id), isNull(recoveryCodes.usedAt)));
    const opened = await this.openSession(auth, user, 'auth.recovery_used', origin);
    return { ...opened, remainingRecoveryCodes: remaining?.n ?? 0 };
  }

  async logout(auth: AuthContext, origin: Origin): Promise<void> {
    await this.sessions.destroy(auth.sessionId);
    await this.audit.record({
      actorId: auth.userId,
      action: 'auth.logout',
      target: `user:${auth.userId}`,
      ip: origin.ip ?? null,
    });
  }

  me(auth: AuthContext): MeResponse {
    return {
      user: toMeUser(auth.user),
      mfaVerified: auth.mfaVerifiedAt !== null,
      mfaEnrolled: auth.user.totpEnabledAt !== null,
      csrfToken: auth.csrfToken,
      expiresAt: auth.expiresAt.toISOString(),
    };
  }

  // ----- Internes -----

  private recoveryHash(normalizedCode: string): string {
    return hmacBase64url(this.env.SESSION_SECRET, 'recovery', normalizedCode);
  }

  private async freshUser(userId: string): Promise<UserRow> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user === undefined) throw new AuthError('UNAUTHENTICATED');
    return user;
  }

  private assertNotLocked(user: UserRow): void {
    if (user.lockedUntil !== null && user.lockedUntil > this.clock.now()) {
      throw new AuthError('ACCOUNT_LOCKED');
    }
  }

  /**
   * Vérifie un code TOTP et réserve son pas de temps de façon atomique : un même code (ou un code
   * plus ancien que le dernier accepté) ne passe jamais deux fois.
   */
  private async acceptTotp(user: UserRow, code: string): Promise<boolean> {
    if (user.totpSecretEnc === null) return false;
    const check = this.totp.check(this.totp.decrypt(user.totpSecretEnc), code);
    if (!check.valid || check.timeStep === undefined) return false;
    const claimed = await this.db
      .update(users)
      .set({ totpLastStep: check.timeStep })
      .where(
        and(
          eq(users.id, user.id),
          sql`(${users.totpLastStep} is null or ${users.totpLastStep} < ${check.timeStep})`,
        ),
      )
      .returning({ id: users.id });
    return claimed.length > 0;
  }

  /** Compte l'échec ; au sixième, verrouille le compte et ferme ses sessions. Lève toujours. */
  private async registerFailure(
    user: UserRow,
    factor: 'password' | 'totp' | 'recovery',
    origin: Origin,
  ): Promise<never> {
    const lockUntil = new Date(this.clock.now().getTime() + LOCK_DURATION_MS);
    const [updated] = await this.db
      .update(users)
      .set({
        failedLoginCount: sql`case when ${users.failedLoginCount} + 1 >= ${MAX_FAILED_ATTEMPTS} then 0 else ${users.failedLoginCount} + 1 end`,
        lockedUntil: sql`case when ${users.failedLoginCount} + 1 >= ${MAX_FAILED_ATTEMPTS} then ${lockUntil.toISOString()}::timestamptz else ${users.lockedUntil} end`,
      })
      .where(eq(users.id, user.id))
      .returning({ lockedUntil: users.lockedUntil });
    const locked =
      (updated?.lockedUntil ?? null) !== null && (updated?.lockedUntil ?? 0) > this.clock.now();
    await this.audit.record({
      actorId: user.id,
      action: factor === 'password' ? 'auth.login_failed' : 'auth.mfa_failed',
      target: `user:${user.id}`,
      payload: { factor },
      ip: origin.ip ?? null,
    });
    if (locked) {
      await this.sessions.destroyAllForUser(user.id);
      await this.audit.record({
        actorId: user.id,
        action: 'auth.account_locked',
        target: `user:${user.id}`,
        payload: { until: lockUntil.toISOString() },
        ip: origin.ip ?? null,
      });
      throw new AuthError('ACCOUNT_LOCKED');
    }
    throw new AuthError(factor === 'password' ? 'INVALID_CREDENTIALS' : 'INVALID_CODE');
  }

  /** Second facteur validé : rotation de la session, remise à zéro des échecs, journal. */
  private async openSession(
    auth: AuthContext,
    user: UserRow,
    action: string,
    origin: Origin,
  ): Promise<{ session: CreatedSession; csrfToken: string; user: MeUser }> {
    const session = await this.sessions.rotate(auth.sessionId, user.id, {
      mfaVerified: true,
      ...origin,
    });
    await this.db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: this.clock.now() })
      .where(eq(users.id, user.id));
    await this.audit.record({
      actorId: user.id,
      action,
      target: `user:${user.id}`,
      ip: origin.ip ?? null,
    });
    return { session, csrfToken: session.csrfToken, user: toMeUser(user) };
  }
}
