import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import type {
  AcceptInvitationRequest,
  CreateInvitationRequest,
  CreateInvitationResponse,
} from '@processia/contracts';
import { invitations, missionMembers, users, authIdentities, type Database } from '@processia/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import { ENV } from '../env.js';
import { randomToken, sha256Hex } from './crypto.js';
import { AuthError } from './errors.js';
import { PasswordService } from './passwords.js';
import type { AuthContext } from './sessions.service.js';
import { AuditService, CLOCK, MailService, type Clock } from './services.js';

export const INVITATION_VALIDITY_HOURS = 72;

class RollbackAccept extends Error {}

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Un responsable de mission n'invite que des consultants et des validateurs, pour une mission
   * dont il est responsable affecté, avec le rôle de mission correspondant [PO-27].
   */
  private async checkScope(input: CreateInvitationRequest, inviter: AuthContext): Promise<void> {
    if (inviter.user.globalRole === 'admin') return;
    const roleFor = { consultant: 'consultant', client_validator: 'validator' } as const;
    const expected = (roleFor as Record<string, string | undefined>)[input.globalRole];
    if (expected === undefined || input.missionId === undefined || input.missionRole !== expected) {
      throw new AuthError('FORBIDDEN');
    }
    const [member] = await this.db
      .select({ role: missionMembers.missionRole })
      .from(missionMembers)
      .where(
        and(
          eq(missionMembers.missionId, input.missionId),
          eq(missionMembers.userId, inviter.userId),
        ),
      )
      .limit(1);
    if (member?.role !== 'manager') throw new AuthError('FORBIDDEN');
  }

  async create(
    input: CreateInvitationRequest,
    inviter: AuthContext,
    ip: string | null,
  ): Promise<CreateInvitationResponse> {
    const createdBy = inviter.userId;
    await this.checkScope(input, inviter);
    const email = input.email.toLowerCase();
    const [existing] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing !== undefined) throw new AuthError('ACCOUNT_EXISTS');

    const token = randomToken();
    const expiresAt = new Date(
      this.clock.now().getTime() + INVITATION_VALIDITY_HOURS * 60 * 60 * 1000,
    );
    const [row] = await this.db
      .insert(invitations)
      .values({
        tokenHash: sha256Hex(token),
        email,
        globalRole: input.globalRole,
        missionId: input.missionId ?? null,
        missionRole: input.missionRole ?? null,
        createdBy,
        expiresAt,
      })
      .returning({ id: invitations.id });
    if (row === undefined) throw new Error('Invitation non créée.');
    try {
      await this.mail.sendInvitation(
        email,
        `${this.env.WEB_ORIGIN}/invitations/${token}`,
        INVITATION_VALIDITY_HOURS,
      );
    } catch (error) {
      await this.db.delete(invitations).where(eq(invitations.id, row.id));
      throw error;
    }
    await this.audit.record({
      actorId: createdBy,
      action: 'auth.invitation_created',
      target: `invitation:${row.id}`,
      payload: { email, globalRole: input.globalRole },
      ip,
    });
    return { id: row.id, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Consomme le lien (usage unique, 72 h) et crée le compte. Le mot de passe est contrôlé avant :
   * un mot de passe refusé ne « brûle » pas l'invitation. La consommation est une mise à jour
   * conditionnelle atomique, dans la même transaction que la création du compte.
   */
  async accept(
    token: string,
    input: AcceptInvitationRequest,
    ip: string | null,
  ): Promise<{ email: string }> {
    if (this.passwords.isWeak(input.password)) throw new AuthError('WEAK_PASSWORD');
    const passwordHash = await this.passwords.hash(input.password);
    const now = this.clock.now();
    let result: { email: string; userId: string } | undefined;
    try {
      await this.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(invitations)
          .set({ acceptedAt: now })
          .where(
            and(
              eq(invitations.tokenHash, sha256Hex(token)),
              isNull(invitations.acceptedAt),
              gt(invitations.expiresAt, now),
            ),
          )
          .returning();
        if (claimed === undefined) throw new AuthError('INVITATION_INVALID');
        const [taken] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, claimed.email))
          .limit(1);
        if (taken !== undefined) throw new RollbackAccept();
        const [user] = await tx
          .insert(users)
          .values({
            email: claimed.email,
            displayName: input.displayName,
            passwordHash,
            globalRole: claimed.globalRole,
            status: 'active',
          })
          .returning({ id: users.id });
        if (user === undefined) throw new Error('Compte non créé.');
        await tx
          .insert(authIdentities)
          .values({ userId: user.id, provider: 'password', subject: user.id });
        if (claimed.missionId !== null && claimed.missionRole !== null) {
          await tx.insert(missionMembers).values({
            missionId: claimed.missionId,
            userId: user.id,
            missionRole: claimed.missionRole,
          });
        }
        result = { email: claimed.email, userId: user.id };
      });
    } catch (error) {
      if (error instanceof RollbackAccept) throw new AuthError('ACCOUNT_EXISTS');
      throw error;
    }
    if (result === undefined) throw new Error('Invitation non traitée.');
    await this.audit.record({
      actorId: result.userId,
      action: 'auth.invitation_accepted',
      target: `user:${result.userId}`,
      ip,
    });
    return { email: result.email };
  }
}
