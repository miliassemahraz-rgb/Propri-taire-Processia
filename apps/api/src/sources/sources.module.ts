import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { IngestService } from './ingest.service.js';
import { SourcesController } from './sources.controller.js';
import { SourcesService } from './sources.service.js';

/** Sources : dépôt, stockage S3, extraction de texte, morceaux, visionneuse (WP-11). */
@Module({
  imports: [AuthModule, AiModule, StorageModule],
  controllers: [SourcesController],
  providers: [SourcesService, IngestService],
  exports: [SourcesService, IngestService],
})
export class SourcesModule {}
