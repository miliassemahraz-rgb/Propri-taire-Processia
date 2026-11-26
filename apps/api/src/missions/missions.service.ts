import { Inject, Injectable } from '@nestjs/common';
import {
  capabilityWarnings,
  type AssignMemberRequest,
  type CreateMissionRequest,
  type CreateMissionResponse,
  type MemberDto,
  MISSION_PHASES,
  type MissionPhase,
  type MissionProgress,
  type MissionSummary,
  type UpdateMissionRequest,
} from '@processia/contracts';
import {
  clients,
  missionMembers,
  missions,
  modelVersions,
  users,
  validationSubmissions,
  withMission,
  type Database,
} from '@processia/db';
import { completeness, overallCompleteness, parseModel } from '@processia/model';
import { can, type GlobalRole, type MissionRole } from '@processia/policy';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { AuthError } from '../auth/errors.js';
import { AuditService, CLOCK, type Clock } from '../auth/services.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { AiConfigService } from '../clients/ai-config.service.js';
import { DB } from '../db/db.module.js';
import type { MissionContext } from '../policy/mission-context.js';

type MissionRow = {
  id: string;
  name: string;
  description: string;
  clientId: string;
  clientName: string;
  phase: string;
  headVersion: number;
  createdAt: Date;
  role: string | null;
};

/** Rôle de mission autorisé selon le rôle global du compte affecté. */
const ASSIGNABLE: Record<Exclude<GlobalRole, 'admin'>, readonly MissionRole[]> = {
  mission_manager: ['manager', 'consultant'],
  consultant: ['consultant'],
  client_validator: ['validator'],
};

/**
 * Phase minimale imposée par la validation du client d'un livrable (PO-31) : une soumission
 * `validated` de ce type interdit tout retour en deçà. Dossier d'analyse validé : plus de retour à
 * `analysis` ; AS-IS validé : plus de retour à `mapping` ; TO-BE validé : plus de retour à
 * `transformation`.
 */
const MIN_PHASE_AFTER_VALIDATION: Record<string, MissionPhase> = {
  analysis_dossier: 'mapping',
  as_is: 'transformation',
  to_be: 'generation',
};

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

@Injectable()
export class MissionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AiConfigService) private readonly aiConfig: AiConfigService,
  ) {}

  /** Avancement : phase, complétude du modèle de tête, soumissions en attente de décision. */
  private async progress(row: MissionRow): Promise<MissionProgress> {
    return withMission(this.db, row.id, async (tx) => {
      const [pending] = await tx
        .select({ n: count() })
        .from(validationSubmissions)
        .where(
          and(
            eq(validationSubmissions.missionId, row.id),
            eq(validationSubmissions.status, 'submitted'),
          ),
        );
      let score: number | null = null;
      if (row.headVersion > 0) {
        const [head] = await tx
          .select({ snapshot: modelVersions.snapshot })
          .from(modelVersions)
          .where(
            and(eq(modelVersions.missionId, row.id), eq(modelVersions.version, row.headVersion)),
          )
          .limit(1);
        if (head !== undefined) {
          const parsed = parseModel(head.snapshot);
          if (parsed.ok) score = overallCompleteness(completeness(parsed.model));
        }
      }
      return {
        phase: row.phase as MissionPhase,
        completeness: score,
        pendingSubmissions: pending?.n ?? 0,
      };
    });
  }

  private async toSummary(row: MissionRow, auth: AuthContext): Promise<MissionSummary> {
    const missionRole = row.role as MissionRole | null;
    const showProgress = can(
      { globalRole: auth.user.globalRole as GlobalRole, missionRole },
      'mission.view_progress',
    );
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      clientId: row.clientId,
      clientName: row.clientName,
      phase: row.phase as MissionPhase,
      headVersion: row.headVersion,
      myRole: missionRole,
      createdAt: row.createdAt.toISOString(),
      progress: showProgress ? await this.progress(row) : null,
    };
  }

  private selectRows(userId: string) {
    return this.db
      .select({
        id: missions.id,
        name: missions.name,
        description: missions.description,
        clientId: missions.clientId,
        clientName: clients.name,
        phase: missions.phase,
        headVersion: missions.headVersion,
        createdAt: missions.createdAt,
        role: missionMembers.missionRole,
      })
      .from(missions)
      .innerJoin(clients, eq(clients.id, missions.clientId))
      .leftJoin(
        missionMembers,
        and(eq(missionMembers.missionId, missions.id), eq(missionMembers.userId, userId)),
      );
  }

  /**
   * Liste de suivi. Administrateur et responsables de mission voient toutes les missions [PO-22] ;
   * consultant et validateur, celles où ils sont affectés.
   */
  async list(auth: AuthContext): Promise<MissionSummary[]> {
    const seesAll = auth.user.globalRole === 'admin' || auth.user.globalRole === 'mission_manager';
    // `missions` et `mission_members` ne sont pas cloisonnées par la RLS : pas de contexte de mission.
    const rows = await this.selectRows(auth.userId)
      .where(
        seesAll
          ? isNull(missions.archivedAt)
          : and(isNull(missions.archivedAt), sql`${missionMembers.id} is not null`),
      )
      .orderBy(desc(missions.createdAt));
    return Promise.all(rows.map((row) => this.toSummary(row, auth)));
  }

  async get(ctx: MissionContext, auth: AuthContext): Promise<MissionSummary> {
    const [row] = await this.selectRows(auth.userId).where(eq(missions.id, ctx.missionId)).limit(1);
    if (row === undefined) throw new AuthError('NOT_FOUND');
    return this.toSummary(row, auth);
  }

  async create(
    input: CreateMissionRequest,
    auth: AuthContext,
    ip: string | null,
  ): Promise<CreateMissionResponse> {
    const [client] = await this.db
      .select()
      .from(clients)
      .where(eq(clients.id, input.clientId))
      .limit(1);
    if (client === undefined) throw new AuthError('NOT_FOUND');
    const retentionUntil = new Date(this.clock.now());
    retentionUntil.setMonth(retentionUntil.getMonth() + client.defaultRetentionMonths);

    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(missions)
        .values({
          clientId: client.id,
          name: input.name,
          description: input.description ?? '',
          retentionUntil,
          createdBy: auth.userId,
        })
        .returning({ id: missions.id });
      if (row === undefined) throw new Error('Mission non créée.');
      // Le responsable qui crée la mission en devient le responsable affecté.
      if (auth.user.globalRole === 'mission_manager') {
        await tx
          .insert(missionMembers)
          .values({ missionId: row.id, userId: auth.userId, missionRole: 'manager' });
      }
      return row.id;
    });
    await this.audit.record({
      actorId: auth.userId,
      action: 'mission.created',
      target: `mission:${id}`,
      payload: { clientId: client.id },
      ip,
    });
    const [row] = await this.selectRows(auth.userId).where(eq(missions.id, id)).limit(1);
    if (row === undefined) throw new Error('Mission introuvable après création.');
    const config = await this.aiConfig.find(client.id);
    return {
      mission: await this.toSummary(row, auth),
      warnings: config === null ? [] : capabilityWarnings(config.capabilities),
    };
  }

  async update(
    ctx: MissionContext,
    input: UpdateMissionRequest,
    auth: AuthContext,
    ip: string | null,
  ): Promise<MissionSummary> {
    if (input.phase !== undefined) await this.assertPhaseAllowed(ctx.missionId, input.phase);
    await this.db
      .update(missions)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.phase === undefined ? {} : { phase: input.phase }),
      })
      .where(eq(missions.id, ctx.missionId));
    await this.audit.record({
      actorId: auth.userId,
      action: input.phase === undefined ? 'mission.updated' : 'mission.phase_changed',
      target: `mission:${ctx.missionId}`,
      payload: { changes: Object.keys(input), ...(input.phase ? { phase: input.phase } : {}) },
      ip,
    });
    return this.get(ctx, auth);
  }

  /**
   * Refuse (409 `PHASE_REGRESSION`) un retour à une phase dont la validation par le client est
   * enregistrée : soumission `validated` (table `validation_submissions`) du livrable concerné.
   */
  private async assertPhaseAllowed(missionId: string, target: MissionPhase): Promise<void> {
    const validated = await withMission(this.db, missionId, (tx) =>
      tx
        .selectDistinct({ kind: validationSubmissions.kind })
        .from(validationSubmissions)
        .where(
          and(
            eq(validationSubmissions.missionId, missionId),
            eq(validationSubmissions.status, 'validated'),
          ),
        ),
    );
    const rank = (phase: MissionPhase): number => MISSION_PHASES.indexOf(phase);
    for (const { kind } of validated) {
      const min = MIN_PHASE_AFTER_VALIDATION[kind];
      if (min !== undefined && rank(target) < rank(min)) {
        throw new AuthError('PHASE_REGRESSION', { kind, minimumPhase: min });
      }
    }
  }

  async members(ctx: MissionContext): Promise<MemberDto[]> {
    const rows = await this.db
      .select({
        userId: users.id,
        displayName: users.displayName,
        email: users.email,
        missionRole: missionMembers.missionRole,
      })
      .from(missionMembers)
      .innerJoin(users, eq(users.id, missionMembers.userId))
      .where(eq(missionMembers.missionId, ctx.missionId))
      .orderBy(asc(users.displayName));
    return rows.map((r) => ({ ...r, missionRole: r.missionRole as MissionRole }));
  }

  async assign(
    ctx: MissionContext,
    input: AssignMemberRequest,
    auth: AuthContext,
    ip: string | null,
  ): Promise<MemberDto[]> {
    const [target] = await this.db.select().from(users).where(eq(users.id, input.userId)).limit(1);
    if (target === undefined) throw new AuthError('NOT_FOUND');
    const allowed = ASSIGNABLE[target.globalRole as Exclude<GlobalRole, 'admin'>];
    // L'administrateur voit déjà toutes les missions : il n'est pas affecté.
    if (allowed === undefined || target.status === 'disabled') throw new AuthError('CONFLICT');
    if (!allowed.includes(input.missionRole)) throw new AuthError('CONFLICT');
    if (input.missionRole === 'validator') {
      const [other] = await this.db
        .select({ userId: missionMembers.userId })
        .from(missionMembers)
        .where(
          and(
            eq(missionMembers.missionId, ctx.missionId),
            eq(missionMembers.missionRole, 'validator'),
          ),
        )
        .limit(1);
      // CDC 2.3 : un seul validateur par mission.
      if (other !== undefined && other.userId !== input.userId) throw new AuthError('CONFLICT');
    }
    try {
      await this.db
        .insert(missionMembers)
        .values({ missionId: ctx.missionId, userId: input.userId, missionRole: input.missionRole })
        .onConflictDoUpdate({
          target: [missionMembers.missionId, missionMembers.userId],
          set: { missionRole: input.missionRole },
        });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AuthError('CONFLICT');
      throw error;
    }
    await this.audit.record({
      actorId: auth.userId,
      action: 'mission.member_assigned',
      target: `mission:${ctx.missionId}`,
      payload: { userId: input.userId, missionRole: input.missionRole },
      ip,
    });
    return this.members(ctx);
  }

  async unassign(
    ctx: MissionContext,
    userId: string,
    auth: AuthContext,
    ip: string | null,
  ): Promise<void> {
    const removed = await this.db
      .delete(missionMembers)
      .where(and(eq(missionMembers.missionId, ctx.missionId), eq(missionMembers.userId, userId)))
      .returning({ id: missionMembers.id });
    if (removed.length === 0) throw new AuthError('NOT_FOUND');
    await this.audit.record({
      actorId: auth.userId,
      action: 'mission.member_removed',
      target: `mission:${ctx.missionId}`,
      payload: { userId },
      ip,
    });
  }
}
