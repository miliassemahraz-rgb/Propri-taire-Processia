import { Body, Controller, Inject, Post } from '@nestjs/common';
import {
  startExtractionSchema,
  type StartExtractionRequest,
  type StartExtractionResult,
} from '@processia/contracts';
import { CurrentAuth, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can, CurrentMission } from '../policy/decorators.js';
import { MissionContext } from '../policy/mission-context.js';
import { ExtractionService } from './extraction.service.js';

/** Analyse de la mission : lancement de l'extraction (« Analyser », WP-12). */
@Controller('missions/:missionId')
export class AnalysisController {
  constructor(@Inject(ExtractionService) private readonly extraction: ExtractionService) {}

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
}
