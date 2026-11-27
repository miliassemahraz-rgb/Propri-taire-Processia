import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  createCommentSchema,
  createSubmissionSchema,
  decideSubmissionSchema,
  listCommentsSchema,
  markNoticesSeenSchema,
  resolveCommentSchema,
  startExportSchema,
  submissionPreviewQuerySchema,
  type CommentDto,
  type CreateCommentRequest,
  type CreateSubmissionRequest,
  type DecideSubmissionRequest,
  type DeliverablesPreviewDto,
  type ListCommentsQuery,
  type MarkNoticesSeenRequest,
  type NoticeDto,
  type PresignedUrlDto,
  type ResolveCommentRequest,
  type StartExportRequest,
  type StartExportResult,
  type SubmissionDto,
  type SubmissionElementDto,
  type SubmissionKind,
  type SubmissionPreviewDto,
  type ValidateSubmissionResult,
} from '@processia/contracts';
import { z } from 'zod';
import { CurrentAuth, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can, CurrentMission } from '../policy/decorators.js';
import { MissionContext } from '../policy/mission-context.js';
import { CommentsService } from './comments.service.js';
import { SubmissionsService, type Viewer } from './submissions.service.js';

const uuidParam = new ZodPipe(z.string().uuid());

const viewerOf = (ctx: MissionContext, auth: AuthContext): Viewer => ({
  userId: auth.user.id,
  isValidator: ctx.missionRole === 'validator',
});
const personOf = (auth: AuthContext): { id: string; name: string } => ({
  id: auth.user.id,
  name: auth.user.displayName,
});

/**
 * Circuit de validation (WP-16) : soumissions, version figée lue par le validateur, signalements
 * après validation. Le validateur n'a ni `model.edit` ni `mission.read_workspace` : il ne voit
 * que les versions figées de ses soumissions.
 */
@Controller('missions/:missionId')
export class ValidationController {
  constructor(@Inject(SubmissionsService) private readonly submissions: SubmissionsService) {}

  @Can('submission.read')
  @Get('submissions')
  list(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<SubmissionDto[]> {
    return this.submissions.list(ctx, viewerOf(ctx, auth));
  }

  /** Aperçu avant soumission : version figée, hypothèses exclues, blocage éventuel. */
  @Can('submission.create')
  @Get('submissions/preview')
  preview(
    @CurrentMission() ctx: MissionContext,
    @Query(new ZodPipe(submissionPreviewQuerySchema)) query: { kind: SubmissionKind },
  ): Promise<SubmissionPreviewDto> {
    return this.submissions.preview(ctx, query.kind);
  }

  @Can('submission.create')
  @Post('submissions')
  submit(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createSubmissionSchema)) body: CreateSubmissionRequest,
  ): Promise<SubmissionDto> {
    return this.submissions.submit(ctx, personOf(auth), body);
  }

  @Can('submission.read')
  @Get('submissions/:submissionId')
  get(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('submissionId', uuidParam) submissionId: string,
  ): Promise<SubmissionDto> {
    return this.submissions.get(ctx, viewerOf(ctx, auth), submissionId);
  }

  /** Livrables de la version figée (jamais de tête, jamais d'hypothèse). */
  @Can('submission.read')
  @Get('submissions/:submissionId/document')
  document(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('submissionId', uuidParam) submissionId: string,
  ): Promise<DeliverablesPreviewDto> {
    return this.submissions.document(ctx, viewerOf(ctx, auth), submissionId);
  }

  @Can('submission.read')
  @Get('submissions/:submissionId/elements')
  elements(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('submissionId', uuidParam) submissionId: string,
  ): Promise<SubmissionElementDto[]> {
    return this.submissions.elements(ctx, viewerOf(ctx, auth), submissionId);
  }

  @Can('submission.read')
  @Get('submissions/:submissionId/exports/:artifactId/download-url')
  downloadUrl(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('submissionId', uuidParam) submissionId: string,
    @Param('artifactId', uuidParam) artifactId: string,
  ): Promise<PresignedUrlDto> {
    return this.submissions.downloadUrl(ctx, viewerOf(ctx, auth), submissionId, artifactId);
  }

  /** Joint un export manquant (échec d'un des trois exports) : le validateur peut aussi le demander. */
  @Can('export.create')
  @Post('submissions/:submissionId/exports')
  startExport(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('submissionId', uuidParam) submissionId: string,
    @Body(new ZodPipe(startExportSchema)) body: StartExportRequest,
  ): Promise<StartExportResult> {
    return this.submissions.startExport(ctx, viewerOf(ctx, auth), submissionId, body.format);
  }

  @Can('submission.create')
  @HttpCode(200)
  @Post('submissions/:submissionId/withdraw')
  withdraw(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('submissionId', uuidParam) submissionId: string,
  ): Promise<SubmissionDto> {
    return this.submissions.withdraw(ctx, personOf(auth), submissionId);
  }

  @Can('submission.create')
  @Post('submissions/:submissionId/replace')
  replace(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('submissionId', uuidParam) submissionId: string,
    @Body(new ZodPipe(decideSubmissionSchema)) body: DecideSubmissionRequest,
  ): Promise<SubmissionDto> {
    return this.submissions.replace(ctx, personOf(auth), submissionId, body.comment);
  }

  /** Le validateur valide le dossier : éléments `validated`, soumission `validated`, phase suivante. */
  @Can('submission.decide')
  @HttpCode(200)
  @Post('submissions/:submissionId/validate')
  validate(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('submissionId', uuidParam) submissionId: string,
    @Body(new ZodPipe(decideSubmissionSchema)) body: DecideSubmissionRequest,
  ): Promise<ValidateSubmissionResult> {
    return this.submissions.validate(ctx, personOf(auth), submissionId, body.comment);
  }

  // ------------------------------------------------------------------ signalements

  @Can('submission.read')
  @Get('notices')
  notices(@CurrentMission() ctx: MissionContext): Promise<NoticeDto[]> {
    return this.submissions.notices(ctx);
  }

  @Can('submission.decide')
  @HttpCode(200)
  @Post('notices/seen')
  seen(
    @CurrentMission() ctx: MissionContext,
    @Body(new ZodPipe(markNoticesSeenSchema)) body: MarkNoticesSeenRequest,
  ): Promise<{ updated: number }> {
    return this.submissions.markNoticesSeen(ctx, body.noticeIds);
  }
}

/** Fils de discussion par élément, livrable ou soumission (WP-16). */
@Controller('missions/:missionId/comments')
export class CommentsController {
  constructor(@Inject(CommentsService) private readonly comments: CommentsService) {}

  @Can('submission.read')
  @Get()
  list(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listCommentsSchema)) query: ListCommentsQuery,
  ): Promise<CommentDto[]> {
    return this.comments.list(ctx, viewerOf(ctx, auth), query);
  }

  @Can('comment.create')
  @Post()
  create(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createCommentSchema)) body: CreateCommentRequest,
  ): Promise<CommentDto> {
    return this.comments.create(ctx, viewerOf(ctx, auth), personOf(auth), body);
  }

  @Can('comment.create')
  @HttpCode(200)
  @Post(':commentId/resolve')
  resolve(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('commentId', uuidParam) commentId: string,
    @Body(new ZodPipe(resolveCommentSchema)) body: ResolveCommentRequest,
  ): Promise<CommentDto> {
    return this.comments.resolve(ctx, viewerOf(ctx, auth), commentId, body.resolved);
  }
}
