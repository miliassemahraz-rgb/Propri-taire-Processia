import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import { sessions, users, type Database } from '@processia/db';
import { and, eq } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import { ENV } from '../env.js';
import { hmacBase64url, randomToken, sha256Hex } from './crypto.js';
import { CLOCK, type Clock } from './services.js';

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
/** `last_seen_at` n'est réécrit qu'au-delà de cet intervalle (évite une écriture par requête). */
const TOUCH_INTERVAL_MS = 30 * 1000;

export type UserRow = typeof users.$inferSelect;

export interface AuthContext {
  sessionId: string;
  userId: string;
  mfaVerifiedAt: Date | null;
  expiresAt: Date;
  csrfToken: string;
  user: UserRow;
}

export interface SessionOrigin {
  ip?: string | null;
  userAgent?: string | null;
}

export interface CreatedSession {
  /** Valeur du cookie : n'est jamais stockée, seul son hachage l'est. */
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Jeton CSRF lié à la session : HMAC de l'identifiant de session, vérifiable sans stockage. */
  csrfFor(token: string): string {
    return hmacBase64url(this.env.SESSION_SECRET, 'csrf', sha256Hex(token));
  }

  async create(
    userId: string,
    options: { mfaVerified: boolean } & SessionOrigin,
  ): Promise<CreatedSession> {
    const now = this.clock.now();
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS);
    await this.db.insert(sessions).values({
      idHash: sha256Hex(token),
      userId,
      mfaVerifiedAt: options.mfaVerified ? now : null,
      expiresAt,
      lastSeenAt: now,
      ip: options.ip ?? null,
      userAgent: options.userAgent?.slice(0, 500) ?? null,
    });
    return { token, csrfToken: this.csrfFor(token), expiresAt };
  }

  /**
   * Renouvelle l'identifiant de session (rotation) : l'ancienne ligne est supprimée, une nouvelle
   * est créée dans la même transaction. Évite la fixation de session.
   */
  async rotate(
    oldSessionId: string,
    userId: string,
    options: { mfaVerified: boolean } & SessionOrigin,
  ): Promise<CreatedSession> {
    const now = this.clock.now();
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS);
    await this.db.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.id, oldSessionId));
      await tx.insert(sessions).values({
        idHash: sha256Hex(token),
        userId,
        mfaVerifiedAt: options.mfaVerified ? now : null,
        expiresAt,
        lastSeenAt: now,
        ip: options.ip ?? null,
        userAgent: options.userAgent?.slice(0, 500) ?? null,
      });
    });
    return { token, csrfToken: this.csrfFor(token), expiresAt };
  }

  /** Retrouve la session valide (non expirée, utilisateur actif) ou `null`. */
  async resolve(token: string): Promise<AuthContext | null> {
    const idHash = sha256Hex(token);
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.idHash, idHash))
      .limit(1);
    if (row === undefined) return null;
    const now = this.clock.now();
    const idleLimit = row.session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS;
    if (
      row.session.expiresAt <= now ||
      idleLimit <= now.getTime() ||
      row.user.status !== 'active'
    ) {
      await this.db.delete(sessions).where(eq(sessions.id, row.session.id));
      return null;
    }
    if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db
        .update(sessions)
        .set({ lastSeenAt: now })
        .where(and(eq(sessions.id, row.session.id)));
    }
    return {
      sessionId: row.session.id,
      userId: row.user.id,
      mfaVerifiedAt: row.session.mfaVerifiedAt,
      expiresAt: row.session.expiresAt,
      csrfToken: this.csrfFor(token),
      user: row.user,
    };
  }

  async destroy(sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  async destroyAllForUser(userId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }
}
