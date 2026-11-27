import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CoherenceWarningDto,
  CommitResult,
  ElementChange,
  ElementHistoryEntry,
  ModelAtVersion,
  NoticeCreatedMessage,
  VersionSummary,
} from '@processia/contracts';
import { MISSION_MESSAGES_CHANNEL } from '@processia/contracts';
import {
  changeProposals,
  missionMembers,
  missions,
  modelVersionElements,
  modelVersions,
  notifications,
  postValidationNotices,
  withMission,
  type Database,
  type MissionTx,
} from '@processia/db';
import {
  applyChangeSet,
  CURRENT_SCHEMA_VERSION,
  diffModels,
  parseModel,
  rebase,
  uuidv7,
  type BusinessModel,
  type ChangeSet,
  type CoherenceIssue,
  type Element,
  type ModelDiff,
  type StatusActor,
} from '@processia/model';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { AuthError } from '../auth/errors.js';
import { CLOCK, type Clock } from '../auth/services.js';
import { DB } from '../db/db.module.js';
import { buildRollback } from './rollback.js';

/** Auteur d'une version : l'acteur sert aux transitions de statut des opérations du ChangeSet. */
export interface CommitAuthor {
  userId: string | null;
  actor: StatusActor;
  aiCallId?: string | null;
}

export interface CommitOptions {
  /** Soumission de validation, exigée pour passer des éléments à `validated` (WP-16). */
  submissionId?: string;
}

/** Version 0 : la mission n'a pas encore de version enregistrée. */
export function emptyModel(missionId: string): BusinessModel {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    missionId,
    version: 0,
    elements: {},
    rejectedHypotheses: [],
    layout: {},
  };
}

function changeKind(fields: string[]): ElementChange {
  return fields.length === 1 && fields[0] === 'status' ? 'status' : 'updated';
}

const label = (el: Element): string => `${el.code} « ${el.label} »`;

/**
 * Persistance versionnée du modèle (WP-08). `commit` est le seul point d'écriture du modèle : les
 * autres modules (dialogue, extraction, validation...) l'appellent avec un ChangeSet.
 */
@Injectable()
export class ModelService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Identifiant persistant (UUID v7) : horloge injectable, aléa du système. */
  newId = (): string => uuidv7(this.clock.now().getTime(), randomBytes(10));

  // ------------------------------------------------------------------ lecture

  /** Charge un instantané ; la version 0 est le modèle vide. */
  async loadModel(tx: MissionTx, missionId: string, version: number): Promise<BusinessModel> {
    if (version === 0) return emptyModel(missionId);
    const [row] = await tx
      .select({ snapshot: modelVersions.snapshot })
      .from(modelVersions)
      .where(and(eq(modelVersions.missionId, missionId), eq(modelVersions.version, version)))
      .limit(1);
    if (row === undefined) throw new AuthError('NOT_FOUND');
    const parsed = parseModel(row.snapshot);
    if (!parsed.ok) {
      throw new Error(`Instantané illisible (mission ${missionId}, version ${version}).`);
    }
    return parsed.model;
  }

  async headVersion(tx: MissionTx, missionId: string): Promise<number> {
    const [row] = await tx
      .select({ head: missions.headVersion })
      .from(missions)
      .where(eq(missions.id, missionId))
      .limit(1);
    if (row === undefined) throw new AuthError('NOT_FOUND');
    return row.head;
  }

  async getModel(tx: MissionTx, missionId: string, version?: number): Promise<ModelAtVersion> {
    const target = version ?? (await this.headVersion(tx, missionId));
    return { version: target, model: await this.loadModel(tx, missionId, target) };
  }

  async listVersions(tx: MissionTx, missionId: string): Promise<VersionSummary[]> {
    const rows = await tx
      .select({
        version: modelVersions.version,
        parentVersion: modelVersions.parentVersion,
        cause: modelVersions.cause,
        summary: modelVersions.summary,
        authorId: modelVersions.authorId,
        createdAt: modelVersions.createdAt,
      })
      .from(modelVersions)
      .where(eq(modelVersions.missionId, missionId))
      .orderBy(desc(modelVersions.version));
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  /** Différence entre deux versions (0 = modèle vide). */
  async diff(tx: MissionTx, missionId: string, from: number, to: number): Promise<ModelDiff> {
    const head = await this.headVersion(tx, missionId);
    if (from > head || to > head) throw new AuthError('NOT_FOUND');
    const [a, b] = [
      await this.loadModel(tx, missionId, from),
      await this.loadModel(tx, missionId, to),
    ];
    return diffModels(a, b);
  }

  /** Versions qui ont touché l'élément, de la plus récente à la plus ancienne. */
  async elementHistory(
    tx: MissionTx,
    missionId: string,
    elementId: string,
  ): Promise<ElementHistoryEntry[]> {
    const rows = await tx
      .select({
        version: modelVersions.version,
        parentVersion: modelVersions.parentVersion,
        cause: modelVersions.cause,
        summary: modelVersions.summary,
        authorId: modelVersions.authorId,
        createdAt: modelVersions.createdAt,
        change: modelVersionElements.change,
      })
      .from(modelVersionElements)
      .innerJoin(
        modelVersions,
        and(
          eq(modelVersions.missionId, modelVersionElements.missionId),
          eq(modelVersions.version, modelVersionElements.version),
        ),
      )
      .where(
        and(
          eq(modelVersionElements.missionId, missionId),
          eq(modelVersionElements.elementId, elementId),
        ),
      )
      .orderBy(desc(modelVersionElements.version));
    if (rows.length === 0) throw new AuthError('NOT_FOUND');
    return rows.map((r) => ({
      ...r,
      change: r.change as ElementChange,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ------------------------------------------------------------------ écriture

  /**
   * Enregistre un ChangeSet : version N+1 et son index, tête de la mission, signalements,
   * notification et `pg_notify`, dans une seule transaction avec le contexte RLS de la mission.
   * Pour les modules qui n'ont pas de `MissionContext` (tâches de fond).
   */
  commit(
    missionId: string,
    cs: ChangeSet,
    author: CommitAuthor,
    options: CommitOptions = {},
  ): Promise<CommitResult> {
    return withMission(this.db, missionId, (tx) =>
      this.commitInTx(tx, missionId, cs, author, options),
    );
  }

  /**
   * Même chose dans la transaction de l'appelant. Contrôle optimiste : la ligne de la mission est
   * verrouillée, la version de départ est comparée à la tête ; en retard, le ChangeSet est rebasé
   * (éléments disjoints) ou refusé (`STALE`).
   */
  async commitInTx(
    tx: MissionTx,
    missionId: string,
    cs: ChangeSet,
    author: CommitAuthor,
    options: CommitOptions = {},
  ): Promise<CommitResult> {
    const headVersion = await this.lockHead(tx, missionId);
    const head = await this.loadModel(tx, missionId, headVersion);
    const { cs: effective, rebasedFrom } = await this.rebaseOnHead(tx, missionId, cs, head);
    const at = this.clock.now().toISOString();
    const applied = applyChangeSet(head, effective, {
      newId: this.newId,
      at,
      ...(author.userId === null ? {} : { userId: author.userId }),
      actor: author.actor,
      ...(options.submissionId === undefined ? {} : { submissionId: options.submissionId }),
    });
    if (!applied.ok) throw new AuthError('CHANGESET_INVALID', applied.errors);
    return this.persist(tx, {
      missionId,
      prev: head,
      next: applied.model,
      diff: applied.diff,
      warnings: applied.warnings,
      changeSet: effective,
      cause: effective.cause,
      summary: effective.summary,
      author,
      rebasedFrom,
    });
  }

  /**
   * Retour arrière vers la version `toVersion` : crée la version N+1 avec son contenu. Les
   * éléments validés touchés passent à `confirmed` et donnent un signalement.
   */
  async rollback(
    tx: MissionTx,
    missionId: string,
    toVersion: number,
    author: CommitAuthor,
  ): Promise<CommitResult> {
    const headVersion = await this.lockHead(tx, missionId);
    if (toVersion >= headVersion) {
      throw new AuthError('VALIDATION_ERROR', [
        { path: 'toVersion', message: 'La version cible doit précéder la version courante.' },
      ]);
    }
    const [head, target] = [
      await this.loadModel(tx, missionId, headVersion),
      await this.loadModel(tx, missionId, toVersion),
    ];
    const built = buildRollback(head, target, { at: this.clock.now().toISOString() });
    const changeSet: ChangeSet & { rollbackTo: number } = {
      baseVersion: headVersion,
      ops: [],
      cause: 'rollback',
      summary: `Retour à la version ${toVersion}`,
      rollbackTo: toVersion,
    };
    return this.persist(tx, {
      missionId,
      prev: head,
      next: built.model,
      diff: built.diff,
      warnings: [],
      changeSet,
      cause: 'rollback',
      summary: changeSet.summary,
      author,
      rebasedFrom: null,
    });
  }

  // ------------------------------------------------------------------ interne

  /** Verrouille la ligne de la mission (sérialise les commits) et renvoie la tête. */
  async lockHead(tx: MissionTx, missionId: string): Promise<number> {
    const [row] = await tx
      .select({ head: missions.headVersion })
      .from(missions)
      .where(eq(missions.id, missionId))
      .for('update')
      .limit(1);
    if (row === undefined) throw new AuthError('NOT_FOUND');
    return row.head;
  }

  /** Diffs des versions `from..to` (bornes comprises), calculés depuis les instantanés si absents. */
  async loadDiffs(
    tx: MissionTx,
    missionId: string,
    from: number,
    to: number,
  ): Promise<ModelDiff[]> {
    if (from > to) return [];
    const rows = await tx
      .select({ version: modelVersions.version, diff: modelVersions.diff })
      .from(modelVersions)
      .where(
        and(
          eq(modelVersions.missionId, missionId),
          gte(modelVersions.version, from),
          lte(modelVersions.version, to),
        ),
      )
      .orderBy(asc(modelVersions.version));
    const out: ModelDiff[] = [];
    for (const row of rows) {
      if (row.diff !== null && row.diff !== undefined) {
        out.push(row.diff as ModelDiff);
      } else {
        const [before, after] = [
          await this.loadModel(tx, missionId, row.version - 1).catch(() => emptyModel(missionId)),
          await this.loadModel(tx, missionId, row.version),
        ];
        out.push(diffModels(before, after));
      }
    }
    return out;
  }

  /** Ramène un ChangeSet en retard sur la tête, ou lève `STALE` avec les éléments en conflit. */
  async rebaseOnHead(
    tx: MissionTx,
    missionId: string,
    cs: ChangeSet,
    head: BusinessModel,
  ): Promise<{ cs: ChangeSet; rebasedFrom: number | null }> {
    if (cs.baseVersion === head.version) return { cs, rebasedFrom: null };
    if (cs.baseVersion > head.version) {
      throw new AuthError('STALE', { headVersion: head.version, conflicts: [] });
    }
    const diffs = await this.loadDiffs(tx, missionId, cs.baseVersion + 1, head.version);
    const r = rebase(cs, diffs, head);
    if (!r.ok) {
      throw new AuthError('STALE', { headVersion: head.version, conflicts: r.conflicts });
    }
    return { cs: r.cs, rebasedFrom: cs.baseVersion };
  }

  private async persist(
    tx: MissionTx,
    input: {
      missionId: string;
      prev: BusinessModel;
      next: BusinessModel;
      diff: ModelDiff;
      warnings: CoherenceIssue[];
      changeSet: unknown;
      cause: string;
      summary: string;
      author: CommitAuthor;
      rebasedFrom: number | null;
    },
  ): Promise<CommitResult> {
    const { missionId, prev, next, diff } = input;
    const version = next.version;

    await tx.insert(modelVersions).values({
      missionId,
      version,
      parentVersion: prev.version > 0 ? prev.version : null,
      snapshot: next,
      changeSet: input.changeSet,
      diff,
      cause: input.cause,
      summary: input.summary,
      authorId: input.author.userId,
      aiCallId: input.author.aiCallId ?? null,
    });

    const indexed: { elementId: string; change: ElementChange }[] = [
      ...diff.added.map((elementId) => ({ elementId, change: 'added' as const })),
      ...diff.removed.map((elementId) => ({ elementId, change: 'removed' as const })),
      ...diff.modified.map((m) => ({ elementId: m.id, change: changeKind(m.fields) })),
    ];
    if (indexed.length > 0) {
      await tx
        .insert(modelVersionElements)
        .values(indexed.map((i) => ({ missionId, version, ...i })));
    }

    await tx.update(missions).set({ headVersion: version }).where(eq(missions.id, missionId));

    const noticed = await this.createNotices(tx, missionId, prev, next, diff);

    // Les consommateurs (serveur de coédition) sont prévenus à la validation de la transaction.
    await tx.execute(
      sql`select pg_notify('mission_events', ${JSON.stringify({ missionId, version })})`,
    );

    await this.refreshProposals(tx, missionId, next);

    return {
      version,
      diff,
      warnings: input.warnings.map((w): CoherenceWarningDto => ({
        code: w.code,
        severity: w.severity,
        elementId: w.elementId,
        message: w.message,
        ...(w.relatedIds === undefined ? {} : { relatedIds: w.relatedIds }),
      })),
      rebasedFrom: input.rebasedFrom,
      noticedElementIds: noticed,
    };
  }

  /**
   * Signalements après validation (CDC 3.6 et 3.7) : un élément `validated` de la version
   * précédente dont le contenu change ou qui disparaît donne un signalement, et une seule
   * notification (regroupée par version) au validateur de la mission [PO-19].
   */
  private async createNotices(
    tx: MissionTx,
    missionId: string,
    prev: BusinessModel,
    next: BusinessModel,
    diff: ModelDiff,
  ): Promise<string[]> {
    const rows: { elementId: string; submissionId: string; summary: string }[] = [];
    const consider = (id: string, removed: boolean, fields: string[]): void => {
      const before = prev.elements[id];
      if (before?.status.value !== 'validated') return;
      const submissionId = before.status.validatedInSubmission;
      if (submissionId === undefined) return;
      if (!removed && next.elements[id]?.status.value === 'validated') return;
      rows.push({
        elementId: id,
        submissionId,
        summary: removed
          ? `${label(before)} retiré après validation (version ${next.version})`
          : `${label(before)} modifié après validation (version ${next.version}) : ${fields.join(', ')}`,
      });
    };
    for (const id of diff.removed) consider(id, true, []);
    for (const m of diff.modified) consider(m.id, false, m.fields);
    if (rows.length === 0) return [];

    const inserted = await tx
      .insert(postValidationNotices)
      .values(rows.map((r) => ({ missionId, version: next.version, ...r })))
      .returning({ id: postValidationNotices.id });

    const validators = await tx
      .select({ userId: missionMembers.userId })
      .from(missionMembers)
      .where(
        and(eq(missionMembers.missionId, missionId), eq(missionMembers.missionRole, 'validator')),
      );
    if (validators.length > 0) {
      await tx.insert(notifications).values(
        validators.map((v) => ({
          userId: v.userId,
          missionId,
          kind: 'post_validation_notice',
          // Courriel immédiat, regroupé par version : une notification = un courriel [PO-19].
          emailPending: true,
          payload: {
            version: next.version,
            noticeIds: inserted.map((i) => i.id),
            elementIds: rows.map((r) => r.elementId),
            summaries: rows.map((r) => r.summary),
          },
        })),
      );
    }
    const message: NoticeCreatedMessage = {
      type: 'notice.created',
      missionId,
      version: next.version,
    };
    await tx.execute(
      sql`select pg_notify(${MISSION_MESSAGES_CHANNEL}, ${JSON.stringify(message)})`,
    );
    return rows.map((r) => r.elementId);
  }

  /** Propositions en attente que la nouvelle tête rend inapplicables : passage en `stale`. */
  private async refreshProposals(
    tx: MissionTx,
    missionId: string,
    head: BusinessModel,
  ): Promise<void> {
    const pending = await tx
      .select({
        id: changeProposals.id,
        baseVersion: changeProposals.baseVersion,
        changeSet: changeProposals.changeSet,
      })
      .from(changeProposals)
      .where(
        and(
          eq(changeProposals.missionId, missionId),
          eq(changeProposals.status, 'pending'),
          sql`${changeProposals.baseVersion} < ${head.version}`,
        ),
      );
    for (const p of pending) {
      const diffs = await this.loadDiffs(tx, missionId, p.baseVersion + 1, head.version);
      const r = rebase(p.changeSet as ChangeSet, diffs, head);
      if (!r.ok) {
        await tx
          .update(changeProposals)
          .set({ status: 'stale' })
          .where(eq(changeProposals.id, p.id));
      }
    }
  }
}
