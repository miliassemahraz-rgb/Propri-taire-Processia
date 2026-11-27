import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import {
  flowDecisionSchema,
  startFlowSchema,
  type FlowDecisionRequest,
  type FlowDecisionResult,
  type FlowOverviewDto,
  type StartFlowRequest,
  type StartFlowResult,
} from '@processia/contracts';
import { z } from 'zod';
import { CurrentAuth, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can, CurrentMission, MissionContext, RequiresPhase } from '../policy/index.js';
import { FlowService } from './flow.service.js';

const idParam = new ZodPipe(z.string().uuid());

/**
 * Enchaînements des processus, niveaux 2 et 3 (WP-17). Toutes les routes de cartographie sont
 * verrouillées par la phase : `409 PHASE_LOCKED` tant que le dossier d'analyse n'est pas validé.
 */
@Controller('missions/:missionId/mapping')
export class FlowController {
  constructor(@Inject(FlowService) private readonly flow: FlowService) {}

  /** Processus du modèle, état de leur enchaînement, tâches détaillables, dernier lot. */
  @Can('mission.read_workspace')
  @RequiresPhase('mapping')
  @Get('processes')
  overview(@CurrentMission() ctx: MissionContext): Promise<FlowOverviewDto> {
    return this.flow.overview(ctx);
  }

  /**
   * Lance le job `process.flow` : tous les processus sans enchaînement, ceux de `processIds`,
   * ou le niveau 3 des tâches de `detailTaskIds`. Suivi : `GET runs/:runId` ou `run.progress`.
   */
  @Can('model.edit')
  @RequiresPhase('mapping')
  @Post('flows')
  start(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(startFlowSchema)) body: StartFlowRequest,
  ): Promise<StartFlowResult> {
    return this.flow.start(ctx, auth.user.id, body);
  }

  /** Confirme ou écarte d'un coup les hypothèses d'un processus (ou du niveau 3 d'une tâche). */
  @Can('model.edit')
  @RequiresPhase('mapping')
  @Post('processes/:processId/decision')
  decide(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('processId', idParam) processId: string,
    @Body(new ZodPipe(flowDecisionSchema)) body: FlowDecisionRequest,
  ): Promise<FlowDecisionResult> {
    return this.flow.decide(ctx, auth.user.id, processId, body);
  }
}
