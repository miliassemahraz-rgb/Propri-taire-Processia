import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import {
  answerQuestionSchema,
  decisionSchema,
  startExtractionSchema,
  type AnswerQuestionRequest,
  type AnswerQuestionResult,
  type DecisionRequest,
  type DecisionResult,
  type QuestionDto,
  type StartExtractionRequest,
  type StartExtractionResult,
  type StartGuidedResult,
  type StopQuestionsResult,
} from '@processia/contracts';
import { z } from 'zod';
import { CurrentAuth, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can, CurrentMission } from '../policy/decorators.js';
import { MissionContext } from '../policy/mission-context.js';
import { DecisionsService } from './decisions.service.js';
import { ExtractionService } from './extraction.service.js';
import { GuidedService } from './guided.service.js';

const idParam = new ZodPipe(z.string().uuid());

/**
 * Analyse de la mission : « Analyser » (extraction, WP-12), questionnement guidé, hypothèses et
 * décisions du consultant sur les éléments (WP-14).
 */
@Controller('missions/:missionId')
export class AnalysisController {
  constructor(
    @Inject(ExtractionService) private readonly extraction: ExtractionService,
    @Inject(GuidedService) private readonly guided: GuidedService,
    @Inject(DecisionsService) private readonly decisions: DecisionsService,
  ) {}

  /**
   * « Analyser » : fige la description (ou prend la source indiquée) puis lance le job
   * `analysis.extraction`. Suivi : `GET runs/:runId` ou le message `run.progress`.
   */
  @Can('model.edit')
  @Post('analysis/extractions')
  start(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(startExtractionSchema)) body: StartExtractionRequest,
  ): Promise<StartExtractionResult> {
    return this.extraction.start(ctx, auth.user.id, body.sourceId);
  }

  /** Questions de la mission : ouvertes (la plus bloquante d'abord), puis répondues et passées. */
  @Can('mission.read_workspace')
  @Get('questions')
  listQuestions(@CurrentMission() ctx: MissionContext): Promise<QuestionDto[]> {
    return ctx.run((tx) => this.guided.list(tx));
  }

  /** Lance le pipeline `questions` : manques de complétude -> questions classées. */
  @Can('model.edit')
  @Post('questions/generate')
  generateQuestions(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<StartGuidedResult> {
    return this.guided.startQuestions(ctx, auth.user.id);
  }

  /** « Arrêter le questionnement » : le consultant décide quand s'arrêter (CDC 3.7). */
  @Can('model.edit')
  @Post('questions/stop')
  stopQuestions(@CurrentMission() ctx: MissionContext): Promise<StopQuestionsResult> {
    return this.guided.stop(ctx);
  }

  /** Répond à une question : source `answer`, puis intégration (`run.progress`, kind `answer`). */
  @Can('model.edit')
  @Post('questions/:questionId/answer')
  answerQuestion(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('questionId', idParam) questionId: string,
    @Body(new ZodPipe(answerQuestionSchema)) body: AnswerQuestionRequest,
  ): Promise<AnswerQuestionResult> {
    return this.guided.answer(ctx, auth.user.id, questionId, body.text);
  }

  @Can('model.edit')
  @Post('questions/:questionId/skip')
  skipQuestion(
    @CurrentMission() ctx: MissionContext,
    @Param('questionId', idParam) questionId: string,
  ): Promise<QuestionDto> {
    return this.guided.skip(ctx, questionId);
  }

  /** Lance le pipeline `hypotheses` (connaissance générale du métier, à examiner). */
  @Can('model.edit')
  @Post('hypotheses/generate')
  generateHypotheses(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<StartGuidedResult> {
    return this.guided.startHypotheses(ctx, auth.user.id);
  }

  /** Lance `deliverable.summary` : synthèse de la fiche métier, proposée comme hypothèse. */
  @Can('model.edit')
  @Post('summary/generate')
  generateSummary(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<StartGuidedResult> {
    return this.guided.startSummary(ctx, auth.user.id);
  }

  /** Confirme, corrige ou rejette un élément `extracted` ou `hypothesis` ; 409 si déjà décidé. */
  @Can('model.edit')
  @Post('elements/:elementId/decision')
  decide(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('elementId', idParam) elementId: string,
    @Body(new ZodPipe(decisionSchema)) body: DecisionRequest,
  ): Promise<DecisionResult> {
    return this.decisions.decide(ctx, auth.user.id, elementId, body);
  }
}
