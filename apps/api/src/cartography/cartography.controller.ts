import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  bpmnQuerySchema,
  diagramIdParamSchema,
  type BpmnDiagramDto,
  type BpmnQuery,
} from '@processia/contracts';
import { CurrentAuth, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can, CurrentMission, MissionContext, RequiresPhase } from '../policy/index.js';
import { CartographyService } from './cartography.service.js';

/**
 * BPMN des diagrammes pour la visionneuse (WP-19). Comme toutes les routes de cartographie :
 * `409 PHASE_LOCKED` tant que le dossier d'analyse n'est pas validé, `403` pour le validateur.
 */
@Controller('missions/:missionId/bpmn')
export class CartographyController {
  constructor(@Inject(CartographyService) private readonly cartography: CartographyService) {}

  /** BPMN 2.0 d'un diagramme (`L0`, `L1:<id>`, `L2:<id>`, `L3:<id>`) ; `?version=` : tête par défaut. */
  @Can('mission.read_workspace')
  @RequiresPhase('mapping')
  @Get(':diagramId')
  diagram(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('diagramId', new ZodPipe(diagramIdParamSchema)) diagramId: string,
    @Query(new ZodPipe(bpmnQuerySchema)) query: BpmnQuery,
  ): Promise<BpmnDiagramDto> {
    return this.cartography.diagram(ctx, auth.user.id, diagramId, query.version);
  }
}
