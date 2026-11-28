import { Inject, Injectable } from '@nestjs/common';
import {
  MISSION_MESSAGES_CHANNEL,
  type CoherenceWarningDto,
  type CommitResult,
  type ProposalDto,
  type ProposalStatus,
  type ProposalUpdatedMessage,
} from '@processia/contracts';
import { changeProposals, type MissionTx } from '@processia/db';
import {
  applyChangeSet,
  rebase,
  type ChangeSet,
  type CoherenceIssue,
  type ModelDiff,
} from '@processia/model';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AuthError } from '../auth/errors.js';
import { CLOCK, type Clock } from '../auth/services.js';
import { ModelService, type CommitAuthor } from './model.service.js';

type ProposalRow = typeof changeProposals.$inferSelect;

export interface CreateProposalInput {
  baseVersion: number;
  instruction: string;
  changeSet: ChangeSet;
  explanation?: string;
  createdBy: string | null;
  aiCallId?: string | null;
}

const toWarnings = (issues: CoherenceIssue[]): CoherenceWarningDto[] =>
  issues.map((w) => ({
    code: w.code,
    severity: w.severity,
    elementId: w.elementId,
    message: w.message,
    ...(w.relatedIds === undefined ? {} : { relatedIds: w.relatedIds }),
  }));

/**
 * Propositions de changement (`change_proposals`) : un ChangeSet prêt, affiché en aperçu, que le
 * consultant applique ou abandonne. Aucune proposition ne modifie le modèle avant `apply`.
 */
@Injectable()
export class ProposalsService {
  constructor(
    @Inject(ModelService) private readonly model: ModelService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Diffuse l'état d'une proposition aux consultants connectés (`proposal.updated`). */
  private async notify(tx: MissionTx, row: ProposalRow): Promise<void> {
    const message: ProposalUpdatedMessage = {
      type: 'proposal.updated',
      missionId: row.missionId,
      proposalId: row.id,
      status: row.status as ProposalStatus,
    };
    await tx.execute(
      sql`select pg_notify(${MISSION_MESSAGES_CHANNEL}, ${JSON.stringify(message)})`,
    );
  }

  private dto(
    row: ProposalRow,
    adaptedToVersion: number | null = null,
    changeSet: unknown = row.changeSet,
  ): ProposalDto {
    return {
      id: row.id,
      baseVersion: row.baseVersion,
      instruction: row.instruction,
      changeSet,
      explanation: row.explanation,
      diff: (row.diff ?? null) as ModelDiff | null,
      warnings: (row.warnings ?? []) as CoherenceWarningDto[],
      status: row.status as ProposalStatus,
      createdBy: row.createdBy,
      appliedVersion: row.appliedVersion,
      createdAt: row.createdAt.toISOString(),
      adaptedToVersion,
    };
  }

  private async find(tx: MissionTx, missionId: string, id: string): Promise<ProposalRow> {
    const [row] = await tx
      .select()
      .from(changeProposals)
      .where(and(eq(changeProposals.missionId, missionId), eq(changeProposals.id, id)))
      .limit(1);
    if (row === undefined) throw new AuthError('NOT_FOUND');
    return row;
  }

  /**
   * Crée une proposition : l'aperçu (différences et incohérences) est calculé sur sa version de
   * départ. Un ChangeSet refusé par les règles du modèle n'est pas enregistré.
   */
  async create(tx: MissionTx, missionId: string, input: CreateProposalInput): Promise<ProposalDto> {
    const head = await this.model.headVersion(tx, missionId);
    if (input.baseVersion > head || input.changeSet.baseVersion !== input.baseVersion) {
      throw new AuthError('VALIDATION_ERROR', [
        { path: 'baseVersion', message: 'Version de départ incohérente.' },
      ]);
    }
    const base = await this.model.loadModel(tx, missionId, input.baseVersion);
    const preview = applyChangeSet(base, input.changeSet, {
      newId: this.model.newId,
      at: this.clock.now().toISOString(),
      actor: 'consultant',
    });
    if (!preview.ok) throw new AuthError('CHANGESET_INVALID', preview.errors);
    const [row] = await tx
      .insert(changeProposals)
      .values({
        missionId,
        baseVersion: input.baseVersion,
        instruction: input.instruction,
        changeSet: input.changeSet,
        explanation: input.explanation ?? null,
        diff: preview.diff,
        warnings: toWarnings(preview.warnings),
        status: 'pending',
        createdBy: input.createdBy,
        aiCallId: input.aiCallId ?? null,
      })
      .returning();
    if (row === undefined) throw new Error('Insertion de la proposition sans retour.');
    await this.notify(tx, row);
    return this.dto(row);
  }

  async list(tx: MissionTx, missionId: string): Promise<ProposalDto[]> {
    const rows = await tx
      .select()
      .from(changeProposals)
      .where(eq(changeProposals.missionId, missionId))
      .orderBy(desc(changeProposals.createdAt));
    return rows.map((r) => this.dto(r));
  }

  /**
   * Aperçu. Si la tête a avancé, il est recalculé sur la tête quand le ChangeSet se rebase
   * (« adapté à la version N ») ; sinon la proposition passe en `stale`.
   */
  async preview(tx: MissionTx, missionId: string, id: string): Promise<ProposalDto> {
    const row = await this.find(tx, missionId, id);
    if (row.status !== 'pending') return this.dto(row);
    const headVersion = await this.model.headVersion(tx, missionId);
    if (row.baseVersion === headVersion) return this.dto(row);
    const head = await this.model.loadModel(tx, missionId, headVersion);
    const diffs = await this.model.loadDiffs(tx, missionId, row.baseVersion + 1, headVersion);
    const rebased = rebase(row.changeSet as ChangeSet, diffs, head);
    const applied = rebased.ok
      ? applyChangeSet(head, rebased.cs, {
          newId: this.model.newId,
          at: this.clock.now().toISOString(),
          actor: 'consultant',
        })
      : null;
    if (applied === null || !applied.ok) {
      const [stale] = await tx
        .update(changeProposals)
        .set({ status: 'stale' })
        .where(eq(changeProposals.id, id))
        .returning();
      if (stale !== undefined) await this.notify(tx, stale);
      return this.dto(stale ?? row);
    }
    return {
      // Le ChangeSet rebasé : l'aperçu côté navigateur s'applique à la tête, pas à l'ancienne base.
      ...this.dto(row, headVersion, rebased.ok ? rebased.cs : row.changeSet),
      diff: applied.diff,
      warnings: toWarnings(applied.warnings),
    };
  }

  /**
   * Applique la proposition (décision humaine de `author`). Si elle n'est plus applicable, elle
   * passe en `stale` et l'appelant reçoit l'erreur après la validation de la transaction.
   */
  async apply(
    tx: MissionTx,
    missionId: string,
    id: string,
    author: CommitAuthor,
  ): Promise<{ result: CommitResult; proposal: ProposalDto } | { stale: AuthError }> {
    const row = await this.find(tx, missionId, id);
    if (row.status !== 'pending') throw new AuthError('CONFLICT', { status: row.status });
    // Savepoint : un échec du commit n'invalide pas la transaction qui note l'état `stale`.
    try {
      const result = await tx.transaction(async (inner) =>
        this.model.commitInTx(
          Object.assign(inner, { missionScoped: true as const }),
          missionId,
          row.changeSet as ChangeSet,
          { ...author, aiCallId: author.aiCallId ?? row.aiCallId },
        ),
      );
      const [updated] = await tx
        .update(changeProposals)
        .set({ status: 'applied', appliedVersion: result.version })
        .where(eq(changeProposals.id, id))
        .returning();
      if (updated !== undefined) await this.notify(tx, updated);
      return { result, proposal: this.dto(updated ?? row) };
    } catch (error) {
      if (
        error instanceof AuthError &&
        (error.code === 'STALE' || error.code === 'CHANGESET_INVALID')
      ) {
        const [stale] = await tx
          .update(changeProposals)
          .set({ status: 'stale' })
          .where(eq(changeProposals.id, id))
          .returning();
        if (stale !== undefined) await this.notify(tx, stale);
        return { stale: error };
      }
      throw error;
    }
  }

  async discard(tx: MissionTx, missionId: string, id: string): Promise<ProposalDto> {
    const row = await this.find(tx, missionId, id);
    if (row.status !== 'pending') throw new AuthError('CONFLICT', { status: row.status });
    const [updated] = await tx
      .update(changeProposals)
      .set({ status: 'discarded' })
      .where(eq(changeProposals.id, id))
      .returning();
    if (updated !== undefined) await this.notify(tx, updated);
    return this.dto(updated ?? row);
  }
}
