import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ModelModule } from '../model/model.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';

/** Livrables de l'étape 1 et exports Word, PDF, Excel du dossier d'analyse (WP-15). */
@Module({
  imports: [AuthModule, ModelModule, StorageModule],
  controllers: [ExportsController],
  providers: [ExportsService],
  exports: [ExportsService],
})
export class ExportsModule {}
