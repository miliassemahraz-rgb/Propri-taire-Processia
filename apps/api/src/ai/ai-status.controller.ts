import { Controller, Get, Inject } from '@nestjs/common';
import type { AiStatus } from '@processia/contracts';
import { CurrentMission } from '../policy/decorators.js';
import { MissionContext } from '../policy/mission-context.js';
import { AiService } from './ai.service.js';

/** État de l'IA de la mission, lisible par tout membre : alimente le bandeau « IA simulée ». */
@Controller('missions')
export class AiStatusController {
  constructor(@Inject(AiService) private readonly ai: AiService) {}

  @Get(':missionId/ai-status')
  async status(@CurrentMission() ctx: MissionContext): Promise<AiStatus> {
    return { simulated: await this.ai.isSimulated(ctx.clientId) };
  }
}
