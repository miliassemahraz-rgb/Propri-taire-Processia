import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ModelModule } from '../model/model.module.js';
import { DialogueController } from './dialogue.controller.js';
import { DialogueService } from './dialogue.service.js';

/** Modification de la cartographie par dialogue : consignes, propositions en aperçu (WP-20). */
@Module({
  imports: [AuthModule, AiModule, ModelModule],
  controllers: [DialogueController],
  providers: [DialogueService],
  exports: [DialogueService],
})
export class DialogueModule {}
