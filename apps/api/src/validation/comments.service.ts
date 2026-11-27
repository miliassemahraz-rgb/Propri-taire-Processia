import { Inject, Injectable } from '@nestjs/common';
import {
  MISSION_MESSAGES_CHANNEL,
  NOTIFICATION_KINDS,
  type CommentCreatedMessage,
  type CommentDto,
  type CommentTargetKind,
  type CreateCommentRequest,
  type ListCommentsQuery,
} from '@processia/contracts';
import {
  comments,
  missionMembers,
  users,
  validationSubmissions,
  type MissionTx,
} from '@processia/db';
import { and, asc, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { AuthError } from '../auth/errors.js';
import { CLOCK, type Clock } from '../auth/services.js';
import { ModelService } from '../model/model.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { MissionContext } from '../policy/mission-context.js';
import { deliveredElements } from './scope.js';
import type { Viewer } from './submissions.service.js';

const EXCERPT_LENGTH = 200;
/** Une soumission accepte des commentaires tant qu'elle est en cours ou validée. */
const COMMENTABLE = ['submitted', 'validated'];

type CommentRow = typeof comments.$inferSelect;

/**
 * Fils de discussion par élément, livrable ou soumission (WP-16, spécification 2.7 et 3.5). Un
 * commentaire lié à une soumission (`submission_id`) forme un fil partagé avec le validateur,
 * sur la version figée ; sans soumission, c'est un commentaire interne de l'équipe, jamais visible
 * du validateur. L'événement part en temps réel aux consultants connectés (`comment.created`) ;
 * le validateur, qui n'utilise pas Yjs, relit la liste régulièrement.
 */
@Injectable()
export class CommentsService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ModelService) private readonly models: ModelService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  async list(ctx: MissionContext, viewer: Viewer, query: ListCommentsQuery): Promise<CommentDto[]> {
    return ctx.run(async (tx) => {
      const filters: SQL[] = [eq(comments.missionId, ctx.missionId)];
      if (query.targetKind !== undefined) filters.push(eq(comments.targetKind, query.targetKind));
      if (query.targetId !== undefined) filters.push(eq(comments.targetId, query.targetId));
      if (viewer.isValidator) {
        // Fils partagés des soumissions non retirées, rien d'autre.
        filters.push(
          isNotNull(comments.submissionId),
          inArray(
            comments.submissionId,
            tx
              .select({ id: validationSubmissions.id })
              .from(validationSubmissions)
              .where(ne(validationSubmissions.status, 'withdrawn')),
          ),
        );
      }
      const rows = await tx
        .select()
        .from(comments)
        .where(and(...filters))
        .orderBy(asc(comments.createdAt), asc(comments.id));
      return this.toDtos(tx, ctx.missionId, rows);
    });
  }

  async create(
    ctx: MissionContext,
    viewer: Viewer,
    author: { id: string; name: string },
    request: CreateCommentRequest,
  ): Promise<CommentDto> {
    return ctx.run(async (tx) => {
      // Le validateur ne commente que sur la version figée d'une de ses soumissions.
      if (viewer.isValidator && request.submissionId === undefined) {
        throw new AuthError('FORBIDDEN');
      }
      let modelVersion: number | null = null;
      if (request.submissionId !== undefined) {
        const [submission] = await tx
          .select()
          .from(validationSubmissions)
          .where(eq(validationSubmissions.id, request.submissionId))
          .limit(1);
        if (submission === undefined || submission.status === 'withdrawn') {
          throw new AuthError('NOT_FOUND');
        }
        if (!COMMENTABLE.includes(submission.status)) {
          throw new AuthError('CONFLICT', { reason: 'SUBMISSION_CLOSED' });
        }
        modelVersion = submission.modelVersion;
        await this.checkTarget(tx, ctx.missionId, submission, request);
      }
      if (request.parentId !== undefined) {
        const [parent] = await tx
          .select({
            submissionId: comments.submissionId,
            targetKind: comments.targetKind,
            targetId: comments.targetId,
          })
          .from(comments)
          .where(eq(comments.id, request.parentId))
          .limit(1);
        if (
          parent === undefined ||
          parent.submissionId !== (request.submissionId ?? null) ||
          parent.targetKind !== request.targetKind ||
          parent.targetId !== request.targetId
        ) {
          throw new AuthError('VALIDATION_ERROR', [
            { path: 'parentId', message: 'Le commentaire parent est introuvable.' },
          ]);
        }
      }
      const [row] = await tx
        .insert(comments)
        .values({
          missionId: ctx.missionId,
          targetKind: request.targetKind,
          targetId: request.targetId,
          modelVersion,
          parentId: request.parentId ?? null,
          submissionId: request.submissionId ?? null,
          authorId: author.id,
          body: request.body,
          createdAt: this.clock.now(),
        })
        .returning();
      if (row === undefined) throw new Error('Insertion du commentaire impossible.');

      if (row.submissionId !== null) {
        // L'autre camp est prévenu dans l'application (pas de courriel : c'est une conversation).
        const recipients = await tx
          .select({ userId: missionMembers.userId })
          .from(missionMembers)
          .where(
            and(
              eq(missionMembers.missionId, ctx.missionId),
              viewer.isValidator
                ? inArray(missionMembers.missionRole, ['manager', 'consultant'])
                : eq(missionMembers.missionRole, 'validator'),
            ),
          );
        await this.notifications.create(tx, {
          userIds: recipients.map((r) => r.userId),
          missionId: ctx.missionId,
          kind: NOTIFICATION_KINDS.comment,
          payload: {
            submissionId: row.submissionId,
            targetKind: row.targetKind,
            targetId: row.targetId,
            authorName: author.name,
            excerpt: row.body.slice(0, EXCERPT_LENGTH),
          },
          email: false,
        });
      }
      await this.broadcast(tx, ctx.missionId, row.targetKind as CommentTargetKind, row.targetId);
      return (await this.toDtos(tx, ctx.missionId, [row]))[0] as CommentDto;
    });
  }

  /** Résout ou rouvre un fil (le commentaire racine et ses réponses). */
  async resolve(
    ctx: MissionContext,
    viewer: Viewer,
    id: string,
    resolved: boolean,
  ): Promise<CommentDto> {
    return ctx.run(async (tx) => {
      const [row] = await tx.select().from(comments).where(eq(comments.id, id)).limit(1);
      if (row === undefined || (viewer.isValidator && row.submissionId === null)) {
        throw new AuthError('NOT_FOUND');
      }
      const [updated] = await tx
        .update(comments)
        .set({ resolvedAt: resolved ? this.clock.now() : null })
        .where(eq(comments.id, id))
        .returning();
      await this.broadcast(tx, ctx.missionId, row.targetKind as CommentTargetKind, row.targetId);
      return (await this.toDtos(tx, ctx.missionId, [updated ?? row]))[0] as CommentDto;
    });
  }

  // ------------------------------------------------------------------ interne

  /** La cible existe dans la version figée : un élément livré, la soumission, un livrable. */
  private async checkTarget(
    tx: MissionTx,
    missionId: string,
    submission: typeof validationSubmissions.$inferSelect,
    request: CreateCommentRequest,
  ): Promise<void> {
    const invalid = (message: string): AuthError =>
      new AuthError('VALIDATION_ERROR', [{ path: 'targetId', message }]);
    switch (request.targetKind) {
      case 'submission':
        if (request.targetId !== submission.id) throw invalid('Soumission inconnue.');
        return;
      case 'element': {
        const model = await this.models.loadModel(tx, missionId, submission.modelVersion);
        if (!deliveredElements(model).some((e) => e.id === request.targetId)) {
          throw invalid('Élément absent de la version soumise.');
        }
        return;
      }
      case 'deliverable':
        if (!/^[a-z_]{1,60}$/.test(request.targetId)) throw invalid('Livrable inconnu.');
        return;
      case 'optimisation':
        // Les optimisations sont commentées avec leur décision (WP-23).
        return;
    }
  }

  private async broadcast(
    tx: MissionTx,
    missionId: string,
    targetKind: CommentTargetKind,
    targetId: string,
  ): Promise<void> {
    const message: CommentCreatedMessage = {
      type: 'comment.created',
      missionId,
      targetKind,
      targetId,
    };
    await tx.execute(
      sql`select pg_notify(${MISSION_MESSAGES_CHANNEL}, ${JSON.stringify(message)})`,
    );
  }

  private async toDtos(
    tx: MissionTx,
    missionId: string,
    rows: CommentRow[],
  ): Promise<CommentDto[]> {
    if (rows.length === 0) return [];
    const authorIds = [...new Set(rows.map((r) => r.authorId))];
    const authors = await tx
      .select({
        id: users.id,
        name: users.displayName,
        role: missionMembers.missionRole,
      })
      .from(users)
      .leftJoin(
        missionMembers,
        and(eq(missionMembers.userId, users.id), eq(missionMembers.missionId, missionId)),
      )
      .where(inArray(users.id, authorIds));
    const byId = new Map(authors.map((a) => [a.id, a]));
    return rows.map((row) => {
      const author = byId.get(row.authorId);
      return {
        id: row.id,
        targetKind: row.targetKind as CommentTargetKind,
        targetId: row.targetId,
        modelVersion: row.modelVersion,
        parentId: row.parentId,
        submissionId: row.submissionId,
        author: {
          id: row.authorId,
          name: author?.name ?? '',
          role: author?.role === 'validator' ? 'validator' : 'team',
        },
        body: row.body,
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
      };
    });
  }
}
