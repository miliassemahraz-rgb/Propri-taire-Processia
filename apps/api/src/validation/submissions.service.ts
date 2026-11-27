import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EXPORT_FORMATS,
  MISSION_MESSAGES_CHANNEL,
  NOTIFICATION_KINDS,
  PRESIGNED_URL_TTL_SECONDS,
  type CreateSubmissionRequest,
  type DeliverablesPreviewDto,
  type ExcludedHypothesisDto,
  type ExportArtifactDto,
  type ExportFormat,
  type MissionPhase,
  type NoticeDto,
  type PresignedUrlDto,
  type SubmissionDto,
  type SubmissionElementDto,
  type SubmissionKind,
  type SubmissionPreviewDto,
  type SubmissionStatus,
  type SubmissionUpdatedMessage,
  type ValidateSubmissionResult,
} from '@processia/contracts';
import {
  artifacts,
  missionMembers,
  missions,
  postValidationNotices,
  users,
  validationSubmissions,
  type Database,
  type MissionTx,
} from '@processia/db';
import { t, type MessageKey } from '@processia/i18n';
import { diffModels, type BusinessModel, type ChangeSet, type Element } from '@processia/model';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { AuthError } from '../auth/errors.js';
import { CLOCK, type Clock } from '../auth/services.js';
import { DB } from '../db/db.module.js';
import { ExportsService, toExportDto } from '../exports/exports.service.js';
import { EXPORT_FORMAT_META } from '@processia/exports';
import { ModelService } from '../model/model.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { MissionContext } from '../policy/mission-context.js';
import { StorageService } from '../storage/storage.service.js';
import {
  deliveredElements,
  excludedHypotheses,
  PHASE_AFTER_VALIDATION,
  phaseRank,
  submissionBlocker,
} from './scope.js';

type SubmissionRow = typeof validationSubmissions.$inferSelect;

/** Qui lit : le validateur ne voit jamais le détail des hypothèses ni les soumissions retirées. */
export interface Viewer {
  userId: string;
  isValidator: boolean;
}

const kindLabel = (kind: SubmissionKind): string => t(`validation.kind.${kind}` as MessageKey);

/**
 * Circuit de validation (WP-16, spécification 2.7), générique pour `analysis_dossier`, `as_is` et
 * `to_be` : soumettre (version figée, exports joints), retirer, remplacer, valider. La validation
 * est un ChangeSet `validation` appliqué par `ModelService.commit` avec l'acteur `validator` et la
 * soumission : c'est le seul chemin vers le statut `validated`. Le validateur ne lit jamais la
 * tête du modèle : seulement la version figée de sa soumission, filtrée par `deliverableView`.
 */
@Injectable()
export class SubmissionsService {
  private readonly logger = new Logger(SubmissionsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ModelService) private readonly models: ModelService,
    @Inject(ExportsService) private readonly exportsService: ExportsService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  // ------------------------------------------------------------------ lecture

  /** Soumissions de la mission, de la plus récente à la plus ancienne. */
  async list(ctx: MissionContext, viewer: Viewer): Promise<SubmissionDto[]> {
    return ctx.run(async (tx) => {
      const rows = await tx
        .select()
        .from(validationSubmissions)
        .where(
          viewer.isValidator
            ? ne(validationSubmissions.status, 'withdrawn')
            : eq(validationSubmissions.missionId, ctx.missionId),
        )
        .orderBy(desc(validationSubmissions.submittedAt), desc(validationSubmissions.round));
      return this.toDtos(tx, ctx.missionId, rows, viewer);
    });
  }

  async get(ctx: MissionContext, viewer: Viewer, id: string): Promise<SubmissionDto> {
    return ctx.run(async (tx) => {
      const row = await this.load(tx, id, viewer);
      return (await this.toDtos(tx, ctx.missionId, [row], viewer))[0] as SubmissionDto;
    });
  }

  /** Aperçu de la soumission : version figée, éléments inclus, hypothèses exclues, blocage. */
  async preview(ctx: MissionContext, kind: SubmissionKind): Promise<SubmissionPreviewDto> {
    return ctx.run(async (tx) => {
      const head = await this.models.headVersion(tx, ctx.missionId);
      const model = await this.models.loadModel(tx, ctx.missionId, head);
      const [validated] = await tx
        .select({ id: validationSubmissions.id })
        .from(validationSubmissions)
        .where(
          and(eq(validationSubmissions.kind, kind), eq(validationSubmissions.status, 'validated')),
        )
        .limit(1);
      const [open] = await tx
        .select({ id: validationSubmissions.id, round: validationSubmissions.round })
        .from(validationSubmissions)
        .where(
          and(eq(validationSubmissions.kind, kind), eq(validationSubmissions.status, 'submitted')),
        )
        .limit(1);
      const delivered = deliveredElements(model);
      return {
        kind,
        modelVersion: head,
        includedCount: delivered.length,
        excludedHypotheses: excludedHypotheses(model).map(toExcluded),
        replaces: open === undefined ? null : { id: open.id, round: open.round },
        blocker: submissionBlocker({
          kind,
          phase: ctx.phase,
          head,
          deliveredCount: delivered.length,
          alreadyValidated: validated !== undefined,
        }),
      };
    });
  }

  /** Document des livrables de la version figée (aperçu HTML du validateur) : jamais de tête. */
  async document(ctx: MissionContext, viewer: Viewer, id: string): Promise<DeliverablesPreviewDto> {
    return ctx.run(async (tx) => {
      const row = await this.load(tx, id, viewer);
      return this.exportsService.preview(tx, ctx.missionId, row.modelVersion);
    });
  }

  /** Éléments de la version figée (vue du validateur) : sans hypothèse, pour les commentaires. */
  async elements(ctx: MissionContext, viewer: Viewer, id: string): Promise<SubmissionElementDto[]> {
    return ctx.run(async (tx) => {
      const row = await this.load(tx, id, viewer);
      const model = await this.models.loadModel(tx, ctx.missionId, row.modelVersion);
      return deliveredElements(model).map((element) => ({
        id: element.id,
        code: element.code,
        label: element.label,
        kind: element.kind,
        status: element.status.value,
      }));
    });
  }

  async downloadUrl(
    ctx: MissionContext,
    viewer: Viewer,
    id: string,
    artifactId: string,
  ): Promise<PresignedUrlDto> {
    const row = await ctx.run((tx) => this.load(tx, id, viewer));
    if (!row.artifactIds.includes(artifactId)) throw new AuthError('NOT_FOUND');
    const artifact = await ctx.run(async (tx) => {
      const [found] = await tx
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, artifactId))
        .limit(1);
      return found;
    });
    if (artifact === undefined) throw new AuthError('NOT_FOUND');
    const dto = toExportDto(artifact);
    return {
      url: await this.storage.presignArtifactDownload(
        artifact.storageKey,
        dto.filename,
        EXPORT_FORMAT_META[dto.format].mime,
      ),
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
      filename: dto.filename,
    };
  }

  /** Signalements après validation, du plus récent au plus ancien. */
  async notices(ctx: MissionContext): Promise<NoticeDto[]> {
    return ctx.run(async (tx) => {
      const rows = await tx
        .select()
        .from(postValidationNotices)
        .orderBy(desc(postValidationNotices.createdAt), desc(postValidationNotices.id));
      return rows.map((row) => ({
        id: row.id,
        submissionId: row.submissionId,
        elementId: row.elementId,
        version: row.version,
        summary: row.summary,
        createdAt: row.createdAt.toISOString(),
        seenAt: row.seenAt?.toISOString() ?? null,
      }));
    });
  }

  /** Le validateur a vu ces signalements : `seen_at` n'est posé qu'une fois. */
  async markNoticesSeen(ctx: MissionContext, noticeIds: string[]): Promise<{ updated: number }> {
    return ctx.run(async (tx) => {
      const rows = await tx
        .update(postValidationNotices)
        .set({ seenAt: this.clock.now() })
        .where(
          and(inArray(postValidationNotices.id, noticeIds), isNull(postValidationNotices.seenAt)),
        )
        .returning({ id: postValidationNotices.id });
      return { updated: rows.length };
    });
  }

  // ------------------------------------------------------------------ écriture

  /**
   * Soumet la version de tête au validateur. Elle remplace la soumission en cours du même type
   * (`superseded`, critère 5). Les exports Word, PDF et Excel de la version figée sont mis en
   * file ensuite : la soumission n'en dépend pas.
   */
  async submit(
    ctx: MissionContext,
    user: { id: string; name: string },
    request: CreateSubmissionRequest,
  ): Promise<SubmissionDto> {
    const viewer: Viewer = { userId: user.id, isValidator: false };
    const created = await ctx.run(async (tx) => {
      const head = await this.models.lockHead(tx, ctx.missionId);
      const model = await this.models.loadModel(tx, ctx.missionId, head);
      const [phaseRow] = await tx
        .select({ phase: missions.phase })
        .from(missions)
        .where(eq(missions.id, ctx.missionId));
      const [validated] = await tx
        .select({ id: validationSubmissions.id })
        .from(validationSubmissions)
        .where(
          and(
            eq(validationSubmissions.kind, request.kind),
            eq(validationSubmissions.status, 'validated'),
          ),
        )
        .limit(1);
      const delivered = deliveredElements(model);
      const blocker = submissionBlocker({
        kind: request.kind,
        phase: phaseRow?.phase ?? ctx.phase,
        head,
        deliveredCount: delivered.length,
        alreadyValidated: validated !== undefined,
      });
      if (blocker !== null) throw new AuthError('CONFLICT', { reason: blocker });

      const replaced = await tx
        .update(validationSubmissions)
        .set({ status: 'superseded' })
        .where(
          and(
            eq(validationSubmissions.kind, request.kind),
            eq(validationSubmissions.status, 'submitted'),
          ),
        )
        .returning({ id: validationSubmissions.id });
      const [last] = await tx
        .select({ round: sql<number>`coalesce(max(${validationSubmissions.round}), 0)::int` })
        .from(validationSubmissions)
        .where(eq(validationSubmissions.kind, request.kind));
      const round = (last?.round ?? 0) + 1;
      const [row] = await tx
        .insert(validationSubmissions)
        .values({
          missionId: ctx.missionId,
          kind: request.kind,
          round,
          modelVersion: head,
          excludedHypothesisIds: excludedHypotheses(model).map((element) => element.id),
          status: 'submitted',
          submittedBy: user.id,
          submittedAt: this.clock.now(),
          ...(request.comment === undefined || request.comment === ''
            ? {}
            : { comment: request.comment }),
        })
        .returning();
      if (row === undefined) throw new Error('Insertion de la soumission impossible.');

      await this.notifications.create(tx, {
        userIds: await this.memberIds(tx, ctx.missionId, ['validator']),
        missionId: ctx.missionId,
        kind: NOTIFICATION_KINDS.submitted,
        payload: {
          submissionId: row.id,
          kind: request.kind,
          kindLabel: kindLabel(request.kind),
          round,
          version: head,
        },
        email: true,
      });
      for (const { id } of replaced) await this.broadcast(tx, ctx.missionId, id, 'superseded');
      await this.broadcast(tx, ctx.missionId, row.id, 'submitted');
      return (await this.toDtos(tx, ctx.missionId, [row], viewer))[0] as SubmissionDto;
    });
    await this.startExports(ctx, user.id, created);
    return created;
  }

  /** Remplace une soumission en cours : une nouvelle soumission du même type, la précédente passe à `superseded`. */
  async replace(
    ctx: MissionContext,
    user: { id: string; name: string },
    id: string,
    comment: string | undefined,
  ): Promise<SubmissionDto> {
    const previous = await ctx.run((tx) =>
      this.load(tx, id, { userId: user.id, isValidator: false }),
    );
    if (previous.status !== 'submitted') {
      throw new AuthError('CONFLICT', { reason: 'NOT_SUBMITTED' });
    }
    return this.submit(ctx, user, {
      kind: previous.kind as SubmissionKind,
      ...(comment === undefined ? {} : { comment }),
    });
  }

  /** Retire une soumission en cours (le consultant la reprend avant la décision du validateur). */
  async withdraw(
    ctx: MissionContext,
    user: { id: string; name: string },
    id: string,
  ): Promise<SubmissionDto> {
    const viewer: Viewer = { userId: user.id, isValidator: false };
    return ctx.run(async (tx) => {
      await this.models.lockHead(tx, ctx.missionId);
      const row = await this.load(tx, id, viewer);
      if (row.status !== 'submitted') throw new AuthError('CONFLICT', { reason: 'NOT_SUBMITTED' });
      const [updated] = await tx
        .update(validationSubmissions)
        .set({ status: 'withdrawn' })
        .where(eq(validationSubmissions.id, id))
        .returning();
      await this.notifications.create(tx, {
        userIds: await this.memberIds(tx, ctx.missionId, ['validator']),
        missionId: ctx.missionId,
        kind: NOTIFICATION_KINDS.withdrawn,
        payload: {
          submissionId: id,
          kind: row.kind,
          kindLabel: kindLabel(row.kind as SubmissionKind),
          round: row.round,
        },
        email: false,
      });
      await this.broadcast(tx, ctx.missionId, id, 'withdrawn');
      return (await this.toDtos(tx, ctx.missionId, [updated ?? row], viewer))[0] as SubmissionDto;
    });
  }

  /**
   * Validation de la soumission par le validateur : les éléments livrés, inchangés depuis la
   * version figée, passent à `validated` dans une nouvelle version (ChangeSet `validation`), la
   * soumission passe à `validated` et la phase avance (`mapping` pour le dossier d'analyse). Tout
   * se fait dans une seule transaction.
   *
   * La validation du TO-BE se fait élément par élément (WP-23) : elle n'est pas ouverte ici.
   */
  async validate(
    ctx: MissionContext,
    user: { id: string; name: string },
    id: string,
    comment: string | undefined,
  ): Promise<ValidateSubmissionResult> {
    const viewer: Viewer = { userId: user.id, isValidator: true };
    return ctx.run(async (tx) => {
      const head = await this.models.lockHead(tx, ctx.missionId);
      const row = await this.load(tx, id, viewer);
      if (row.status !== 'submitted') throw new AuthError('CONFLICT', { reason: 'NOT_SUBMITTED' });
      const kind = row.kind as SubmissionKind;
      if (kind === 'to_be') throw new AuthError('CONFLICT', { reason: 'DECIDE_PER_ELEMENT' });

      const frozen = await this.models.loadModel(tx, ctx.missionId, row.modelVersion);
      const current = await this.models.loadModel(tx, ctx.missionId, head);
      // Contenu modifié ou retiré depuis la version figée : ces éléments restent à leur statut.
      const drift = diffModels(frozen, current);
      const changed = new Set<string>([
        ...drift.removed,
        ...drift.modified.filter((m) => m.fields.some((f) => f !== 'status')).map((m) => m.id),
      ]);
      const skipped: string[] = [];
      const ops: ChangeSet['ops'] = [];
      for (const element of deliveredElements(frozen)) {
        const now: Element | undefined = current.elements[element.id];
        const eligible =
          now !== undefined &&
          (now.status.value === 'extracted' || now.status.value === 'confirmed');
        if (changed.has(element.id) || !eligible) {
          if (now?.status.value !== 'validated') skipped.push(element.id);
          continue;
        }
        ops.push({ op: 'set_status', id: element.id, status: 'validated' });
      }

      let version: number | null = null;
      if (ops.length > 0) {
        const committed = await this.models.commitInTx(
          tx,
          ctx.missionId,
          {
            baseVersion: head,
            ops,
            cause: 'validation',
            summary: t('validation.changeSetSummary', {
              kind: kindLabel(kind),
              round: row.round,
              count: ops.length,
            }),
          },
          { userId: user.id, actor: 'validator' },
          { submissionId: row.id },
        );
        version = committed.version;
      }

      const [updated] = await tx
        .update(validationSubmissions)
        .set({
          status: 'validated',
          decidedBy: user.id,
          decidedAt: this.clock.now(),
          ...(comment === undefined || comment === '' ? {} : { comment }),
        })
        .where(eq(validationSubmissions.id, row.id))
        .returning();

      const [mission] = await tx
        .select({ phase: missions.phase })
        .from(missions)
        .where(eq(missions.id, ctx.missionId));
      const next: MissionPhase | null = PHASE_AFTER_VALIDATION[kind];
      let phase = mission?.phase ?? ctx.phase;
      if (next !== null && phaseRank(phase) < phaseRank(next)) {
        await tx.update(missions).set({ phase: next }).where(eq(missions.id, ctx.missionId));
        phase = next;
      }

      await this.notifications.create(tx, {
        userIds: await this.memberIds(tx, ctx.missionId, ['manager', 'consultant']),
        missionId: ctx.missionId,
        kind: NOTIFICATION_KINDS.validated,
        payload: {
          submissionId: row.id,
          kind,
          kindLabel: kindLabel(kind),
          round: row.round,
          version: version ?? row.modelVersion,
          validatorName: user.name,
        },
        email: true,
      });
      await this.broadcast(tx, ctx.missionId, row.id, 'validated');
      const submission = (await this.toDtos(tx, ctx.missionId, [updated ?? row], viewer))[0];
      return {
        version,
        validatedCount: ops.length,
        skippedChangedIds: skipped,
        phase,
        submission: submission as SubmissionDto,
      };
    });
  }

  /** Exports joints à la soumission, sur le même format ; refusé si le format est déjà joint. */
  async startExport(
    ctx: MissionContext,
    viewer: Viewer,
    id: string,
    format: ExportFormat,
  ): Promise<{ runId: string; modelVersion: number }> {
    const row = await ctx.run((tx) => this.load(tx, id, viewer));
    if (row.status === 'withdrawn') throw new AuthError('NOT_FOUND');
    const attached = await ctx.run(async (tx) =>
      row.artifactIds.length === 0
        ? []
        : tx
            .select({ kind: artifacts.kind })
            .from(artifacts)
            .where(inArray(artifacts.id, row.artifactIds)),
    );
    if (attached.some((a) => a.kind === format)) {
      throw new AuthError('CONFLICT', { reason: 'EXPORT_EXISTS' });
    }
    return this.exportsService.start(ctx, viewer.userId, format, {
      submissionId: row.id,
      modelVersion: row.modelVersion,
    });
  }

  // ------------------------------------------------------------------ interne

  private async startExports(
    ctx: MissionContext,
    userId: string,
    submission: SubmissionDto,
  ): Promise<void> {
    for (const format of EXPORT_FORMATS) {
      try {
        await this.exportsService.start(ctx, userId, format, {
          submissionId: submission.id,
          modelVersion: submission.modelVersion,
        });
      } catch (error) {
        // La soumission existe : un export en échec se relance depuis la page.
        this.logger.error(
          `Export ${format} de la soumission ${submission.id} non lancé : ${String(error)}`,
        );
      }
    }
  }

  /** Charge une soumission ; le validateur ne voit pas les soumissions retirées (404). */
  async load(tx: MissionTx, id: string, viewer: Viewer): Promise<SubmissionRow> {
    const [row] = await tx
      .select()
      .from(validationSubmissions)
      .where(eq(validationSubmissions.id, id))
      .limit(1);
    if (row === undefined || (viewer.isValidator && row.status === 'withdrawn')) {
      throw new AuthError('NOT_FOUND');
    }
    return row;
  }

  private async memberIds(
    tx: MissionTx,
    missionId: string,
    roles: ('manager' | 'consultant' | 'validator')[],
  ): Promise<string[]> {
    const rows = await tx
      .select({ userId: missionMembers.userId })
      .from(missionMembers)
      .where(
        and(eq(missionMembers.missionId, missionId), inArray(missionMembers.missionRole, roles)),
      );
    return rows.map((r) => r.userId);
  }

  private async broadcast(
    tx: MissionTx,
    missionId: string,
    submissionId: string,
    status: SubmissionStatus,
  ): Promise<void> {
    const message: SubmissionUpdatedMessage = {
      type: 'submission.updated',
      missionId,
      submissionId,
      status,
    };
    await tx.execute(
      sql`select pg_notify(${MISSION_MESSAGES_CHANNEL}, ${JSON.stringify(message)})`,
    );
  }

  private async toDtos(
    tx: MissionTx,
    missionId: string,
    rows: SubmissionRow[],
    viewer: Viewer,
  ): Promise<SubmissionDto[]> {
    if (rows.length === 0) return [];
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.submittedBy, r.decidedBy ?? r.submittedBy])),
    ];
    const names = new Map(
      (
        await tx
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(inArray(users.id, userIds))
      ).map((u) => [u.id, u.name]),
    );
    const artifactIds = [...new Set(rows.flatMap((r) => r.artifactIds))];
    const artifactRows =
      artifactIds.length === 0
        ? []
        : await tx.select().from(artifacts).where(inArray(artifacts.id, artifactIds));
    const byId = new Map(artifactRows.map((a) => [a.id, a]));
    const models = new Map<number, BusinessModel>();
    const modelOf = async (version: number): Promise<BusinessModel> => {
      const cached = models.get(version);
      if (cached !== undefined) return cached;
      const loaded = await this.models.loadModel(tx, missionId, version);
      models.set(version, loaded);
      return loaded;
    };
    const out: SubmissionDto[] = [];
    for (const row of rows) {
      const exports: ExportArtifactDto[] = row.artifactIds
        .map((artifactId) => byId.get(artifactId))
        .filter((a): a is NonNullable<typeof a> => a !== undefined)
        .map(toExportDto)
        .sort((a, b) => a.format.localeCompare(b.format));
      const dto: SubmissionDto = {
        id: row.id,
        missionId: row.missionId,
        kind: row.kind as SubmissionKind,
        round: row.round,
        modelVersion: row.modelVersion,
        status: row.status as SubmissionStatus,
        submittedBy: { id: row.submittedBy, name: names.get(row.submittedBy) ?? '' },
        submittedAt: row.submittedAt.toISOString(),
        decidedBy:
          row.decidedBy === null
            ? null
            : { id: row.decidedBy, name: names.get(row.decidedBy) ?? '' },
        decidedAt: row.decidedAt?.toISOString() ?? null,
        comment: row.comment,
        exports,
        excludedCount: row.excludedHypothesisIds.length,
      };
      if (!viewer.isValidator) {
        const frozen = await modelOf(row.modelVersion);
        dto.excludedHypotheses = row.excludedHypothesisIds
          .map((hid) => frozen.elements[hid])
          .filter((e): e is Element => e !== undefined)
          .map(toExcluded);
      }
      out.push(dto);
    }
    return out;
  }
}

function toExcluded(element: Element): ExcludedHypothesisDto {
  return { id: element.id, code: element.code, label: element.label, kind: element.kind };
}
