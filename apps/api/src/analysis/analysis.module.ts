import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ModelModule } from '../model/model.module.js';
import { SourcesModule } from '../sources/sources.module.js';
import { AnalysisController } from './analysis.controller.js';
import { DecisionsService } from './decisions.service.js';
import { ExtractionService } from './extraction.service.js';
import { GuidedService } from './guided.service.js';

/** Extraction (WP-12), questionnement guidé, hypothèses et décisions (WP-14). */
@Module({
  imports: [AuthModule, AiModule, ModelModule, SourcesModule],
  controllers: [AnalysisController],
  providers: [ExtractionService, GuidedService, DecisionsService],
  exports: [ExtractionService, GuidedService, DecisionsService],
})
export class AnalysisModule {}
