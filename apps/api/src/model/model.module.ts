import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ModelController } from './model.controller.js';
import { ModelService } from './model.service.js';
import { ProposalsService } from './proposals.service.js';

/** Persistance versionnée du modèle, historique, retour arrière, propositions (WP-08). */
@Module({
  imports: [AuthModule],
  controllers: [ModelController],
  providers: [ModelService, ProposalsService],
  exports: [ModelService, ProposalsService],
})
export class ModelModule {}
