import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  commitChangeSetRequestSchema,
  diffQuerySchema,
  modelQuerySchema,
  rollbackRequestSchema,
  type CommitChangeSetRequest,
  type CommitResult,
  type ElementHistoryEntry,
  type ModelAtVersion,
  type ProposalDto,
  type RollbackRequest,
  type VersionSummary,
} from '@processia/contracts';
import type { ModelDiff, StatusActor } from '@processia/model';
import { z } from 'zod';
import { CurrentAuth, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can, CurrentMission } from '../policy/decorators.js';
import { MissionContext } from '../policy/mission-context.js';
import { ModelService, type CommitAuthor } from './model.service.js';
import { ProposalsService } from './proposals.service.js';

const idParam = new ZodPipe(z.string().min(1).max(100));

/** Le responsable de mission décide comme « mission_lead », les autres comme consultant. */
function authorOf(ctx: MissionContext, auth: AuthContext): CommitAuthor {
  const actor: StatusActor = ctx.missionRole === 'manager' ? 'mission_lead' : 'consultant';
  return { userId: auth.user.id, actor };
}

/**
 * Lecture et écriture du modèle versionné. Toutes les routes portent `:missionId` : mission non
 * visible = 404, droit insuffisant = 403 (`PolicyGuard`).
 */
@Controller('missions/:missionId')
export class ModelController {
  constructor(
    @Inject(ModelService) private readonly model: ModelService,
    @Inject(ProposalsService) private readonly proposals: ProposalsService,
  ) {}

  /** Modèle de la version demandée (tête par défaut). */
  @Can('mission.read_workspace')
  @Get('model')
  get(
    @CurrentMission() ctx: MissionContext,
    @Query(new ZodPipe(modelQuerySchema)) query: { version?: number | undefined },
  ): Promise<ModelAtVersion> {
    return ctx.run((tx) => this.model.getModel(tx, ctx.missionId, query.version));
  }

  @Can('mission.read_workspace')
  @Get('model/versions')
  versions(@CurrentMission() ctx: MissionContext): Promise<VersionSummary[]> {
    return ctx.run((tx) => this.model.listVersions(tx, ctx.missionId));
  }

  @Can('mission.read_workspace')
  @Get('model/diff')
  diff(
    @CurrentMission() ctx: MissionContext,
    @Query(new ZodPipe(diffQuerySchema)) query: { from: number; to: number },
  ): Promise<ModelDiff> {
    return ctx.run((tx) => this.model.diff(tx, ctx.missionId, query.from, query.to));
  }

  @Can('mission.read_workspace')
  @Get('elements/:elementId/history')
  history(
    @CurrentMission() ctx: MissionContext,
    @Param('elementId', idParam) elementId: string,
  ): Promise<ElementHistoryEntry[]> {
    return ctx.run((tx) => this.model.elementHistory(tx, ctx.missionId, elementId));
  }

  /** Enregistre un ChangeSet (version N+1) ; `409 STALE` en cas de conflit avec la tête. */
  @Can('model.edit')
  @Post('model/changes')
  commit(
    @CurrentMission() ctx: MissionContext,
    @Body(new ZodPipe(commitChangeSetRequestSchema)) body: CommitChangeSetRequest,
    @CurrentAuth() auth: AuthContext,
  ): Promise<CommitResult> {
    return ctx.run((tx) =>
      this.model.commitInTx(tx, ctx.missionId, body.changeSet, authorOf(ctx, auth)),
    );
  }

  /** Retour arrière : crée la version N+1 avec le contenu de `toVersion`. */
  @Can('history.rollback')
  @Post('model/rollback')
  rollback(
    @CurrentMission() ctx: MissionContext,
    @Body(new ZodPipe(rollbackRequestSchema)) body: RollbackRequest,
    @CurrentAuth() auth: AuthContext,
  ): Promise<CommitResult> {
    return ctx.run((tx) =>
      this.model.rollback(tx, ctx.missionId, body.toVersion, authorOf(ctx, auth)),
    );
  }

  @Can('mission.read_workspace')
  @Get('proposals')
  listProposals(@CurrentMission() ctx: MissionContext): Promise<ProposalDto[]> {
    return ctx.run((tx) => this.proposals.list(tx, ctx.missionId));
  }

  /** Aperçu d'une proposition (recalculé sur la tête si elle a avancé). */
  @Can('mission.read_workspace')
  @Get('proposals/:proposalId')
  preview(
    @CurrentMission() ctx: MissionContext,
    @Param('proposalId', idParam) proposalId: string,
  ): Promise<ProposalDto> {
    return ctx.run((tx) => this.proposals.preview(tx, ctx.missionId, proposalId));
  }

  @Can('model.edit')
  @Post('proposals/:proposalId/apply')
  async apply(
    @CurrentMission() ctx: MissionContext,
    @Param('proposalId', idParam) proposalId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<{ result: CommitResult; proposal: ProposalDto }> {
    const outcome = await ctx.run((tx) =>
      this.proposals.apply(tx, ctx.missionId, proposalId, authorOf(ctx, auth)),
    );
    // L'état `stale` est enregistré avant de répondre 409.
    if ('stale' in outcome) throw outcome.stale;
    return outcome;
  }

  @Can('model.edit')
  @Post('proposals/:proposalId/discard')
  discard(
    @CurrentMission() ctx: MissionContext,
    @Param('proposalId', idParam) proposalId: string,
  ): Promise<ProposalDto> {
    return ctx.run((tx) => this.proposals.discard(tx, ctx.missionId, proposalId));
  }
}
