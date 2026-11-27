import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AnalysisModule } from '../analysis/analysis.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ModelModule } from '../model/model.module.js';
import { FlowController } from './flow.controller.js';
import { FlowService } from './flow.service.js';

/** Cartographie : enchaînements des processus, niveaux 2 et 3 (WP-17). */
@Module({
  imports: [AuthModule, AiModule, ModelModule, AnalysisModule],
  controllers: [FlowController],
  providers: [FlowService],
  exports: [FlowService],
})
export class MappingModule {}
