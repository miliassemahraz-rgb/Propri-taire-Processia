import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ModelModule } from '../model/model.module.js';
import { SourcesModule } from '../sources/sources.module.js';
import { AnalysisController } from './analysis.controller.js';
import { ExtractionService } from './extraction.service.js';

/** Extraction, réconciliation et écarts : job `analysis.extraction` (WP-12). */
@Module({
  imports: [AuthModule, AiModule, ModelModule, SourcesModule],
  controllers: [AnalysisController],
  providers: [ExtractionService],
  exports: [ExtractionService],
})
export class AnalysisModule {}
