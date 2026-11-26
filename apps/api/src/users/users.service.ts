import { Inject, Injectable } from '@nestjs/common';
import type { UpdateUserRequest, UserSummary } from '@processia/contracts';
import { sessions, users, type Database } from '@processia/db';
import { asc, eq } from 'drizzle-orm';
import { AuditService } from '../auth/services.js';
import { AuthError } from '../auth/errors.js';
import { DB } from '../db/db.module.js';

type UserRow = typeof users.$inferSelect;

export function toUserSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    globalRole: row.globalRole as UserSummary['globalRole'],
    status: row.status as UserSummary['status'],
    totpEnabled: row.totpEnabledAt !== null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}

/** Administration des comptes (droit `users.manage`). */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(): Promise<UserSummary[]> {
    const rows = await this.db.select().from(users).orderBy(asc(users.displayName));
    return rows.map(toUserSummary);
  }

  async get(id: string): Promise<UserSummary> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (row === undefined) throw new AuthError('NOT_FOUND');
    return toUserSummary(row);
  }

  /** Déverrouille immédiatement un compte bloqué après des échecs d'authentification [PO-26]. */
  async unlock(id: string, actorId: string, ip: string | null): Promise<UserSummary> {
    const [row] = await this.db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, id))
      .returning();
    if (row === undefined) throw new AuthError('NOT_FOUND');
    await this.audit.record({
      actorId,
      action: 'auth.account_unlocked',
      target: `user:${id}`,
      ip,
    });
    return toUserSummary(row);
  }

  async update(
    id: string,
    input: UpdateUserRequest,
    actorId: string,
    ip: string | null,
  ): Promise<UserSummary> {
    const current = await this.get(id);
    if (id === actorId) {
      // Un administrateur ne peut ni se rétrograder ni se désactiver : il ne resterait personne.
      if (
        (input.globalRole !== undefined && input.globalRole !== current.globalRole) ||
        (input.status !== undefined && input.status !== current.status)
      ) {
        throw new AuthError('FORBIDDEN');
      }
    }
    if (current.status === 'invited' && input.status === 'active') {
      // L'activation passe par l'acceptation de l'invitation.
      throw new AuthError('CONFLICT');
    }
    const [row] = await this.db
      .update(users)
      .set({
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.globalRole === undefined ? {} : { globalRole: input.globalRole }),
        ...(input.status === undefined ? {} : { status: input.status }),
      })
      .where(eq(users.id, id))
      .returning();
    if (row === undefined) throw new AuthError('NOT_FOUND');
    // Un compte désactivé perd ses sessions immédiatement.
    if (input.status === 'disabled') {
      await this.db.delete(sessions).where(eq(sessions.userId, id));
    }
    await this.audit.record({
      actorId,
      action: 'user.updated',
      target: `user:${id}`,
      payload: { changes: Object.keys(input) },
      ip,
    });
    return toUserSummary(row);
  }
}
