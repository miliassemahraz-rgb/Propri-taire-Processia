import { Controller, Get } from '@nestjs/common';
import { Can, CurrentMission, RequiresPhase } from '../policy/decorators.js';
import { MissionContext } from '../policy/mission-context.js';

/**
 * Point d'entrée de la cartographie, verrouillé par la phase (CDC 3.6, PO-6) : `409 PHASE_LOCKED`
 * tant que le dossier d'analyse n'est pas validé. Les routes d'enchaînement (WP-17), de BPMN
 * (WP-18, WP-19) et de dialogue de modification (WP-20) portent le même `@RequiresPhase('mapping')`.
 */
@Controller('missions/:missionId/mapping')
export class MappingGateController {
  @Can('mission.read_workspace')
  @RequiresPhase('mapping')
  @Get()
  status(@CurrentMission() ctx: MissionContext): { phase: string; unlocked: true } {
    return { phase: ctx.phase, unlocked: true };
  }
}
