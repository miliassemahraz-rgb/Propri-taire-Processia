import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import {
  sendDialogueMessageSchema,
  type DialogueDto,
  type RegenerateProposalResult,
  type SendDialogueMessageRequest,
  type SendDialogueResult,
} from '@processia/contracts';
import { z } from 'zod';
import { CurrentAuth, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can, CurrentMission, MissionContext, RequiresPhase } from '../policy/index.js';
import { DialogueService } from './dialogue.service.js';

const idParam = new ZodPipe(z.string().uuid());
/** « Régénérer » : le corps ne porte que le diagramme affiché (facultatif). */
const regenerateSchema = sendDialogueMessageSchema.pick({ focus: true });

/**
 * Modification par dialogue de la cartographie (WP-20). Comme toutes les routes de cartographie :
 * `@Can` puis `@RequiresPhase('mapping')` (409 `PHASE_LOCKED` avant la validation du dossier
 * d'analyse). Appliquer ou abandonner une proposition passe par `proposals/:id/apply|discard`
 * (WP-08), qui ne modifient le modèle que sur décision explicite du consultant.
 */
@Controller('missions/:missionId/dialogue')
export class DialogueController {
  constructor(@Inject(DialogueService) private readonly dialogue: DialogueService) {}

  /** Fil du dialogue et propositions qu'il référence. */
  @Can('mission.read_workspace')
  @RequiresPhase('mapping')
  @Get()
  list(@CurrentMission() ctx: MissionContext): Promise<DialogueDto> {
    return this.dialogue.list(ctx);
  }

  /** Une consigne en langage naturel : l'assistant répond par une proposition ou une question. */
  @Can('model.edit')
  @RequiresPhase('mapping')
  @Post('messages')
  send(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(sendDialogueMessageSchema)) body: SendDialogueMessageRequest,
  ): Promise<SendDialogueResult> {
    return this.dialogue.send(ctx, auth.user.id, body);
  }

  /** « Régénérer sur la version actuelle » : une proposition `stale` relance le pipeline. */
  @Can('model.edit')
  @RequiresPhase('mapping')
  @Post('proposals/:proposalId/regenerate')
  regenerate(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Param('proposalId', idParam) proposalId: string,
    @Body(new ZodPipe(regenerateSchema)) body: Pick<SendDialogueMessageRequest, 'focus'>,
  ): Promise<RegenerateProposalResult> {
    return this.dialogue.regenerate(ctx, auth.user.id, proposalId, body.focus);
  }
}
