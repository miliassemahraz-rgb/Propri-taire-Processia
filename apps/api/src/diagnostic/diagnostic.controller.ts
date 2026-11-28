import { Controller, Get, Inject, Post } from '@nestjs/common';
import type { DiagnosticOverviewDto, StartDiagnosticResult } from '@processia/contracts';
import { CurrentAuth } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can, CurrentMission, MissionContext, RequiresPhase } from '../policy/index.js';
import { DiagnosticService } from './diagnostic.service.js';

/**
 * Diagnostic de l'AS-IS (WP-21). Verrouillé par la phase : `409 PHASE_LOCKED` tant que le validateur
 * n'a pas validé l'AS-IS (la mission passe alors en `transformation`) ; `403` pour le validateur.
 * Les constats se confirment ou se rejettent par `POST elements/:elementId/decision` (WP-14).
 */
@Controller('missions/:missionId/diagnostic')
export class DiagnosticController {
  constructor(@Inject(DiagnosticService) private readonly diagnostic: DiagnosticService) {}

  /** Périmètre, nombre de constats et dernière exécution. */
  @Can('mission.read_workspace')
  @RequiresPhase('transformation')
  @Get()
  overview(@CurrentMission() ctx: MissionContext): Promise<DiagnosticOverviewDto> {
    return this.diagnostic.overview(ctx);
  }

  /** Lance le job `diagnostic` (détecteurs, puis pipeline par macroprocessus). Suivi : `GET runs/:runId`. */
  @Can('model.edit')
  @RequiresPhase('transformation')
  @Post('runs')
  start(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<StartDiagnosticResult> {
    return this.diagnostic.start(ctx, auth.user.id);
  }
}
