import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ExportsModule } from '../exports/exports.module.js';
import { ModelModule } from '../model/model.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { CommentsService } from './comments.service.js';
import { MappingGateController } from './mapping.controller.js';
import { SubmissionsService } from './submissions.service.js';
import { CommentsController, ValidationController } from './validation.controller.js';

/**
 * Circuit de validation, commentaires et signalements (WP-16) ; verrou de phase de la
 * cartographie. Générique pour `analysis_dossier`, `as_is` et `to_be` (WP-21, WP-23).
 */
@Module({
  imports: [AuthModule, ModelModule, ExportsModule, NotificationsModule, StorageModule],
  controllers: [ValidationController, CommentsController, MappingGateController],
  providers: [SubmissionsService, CommentsService],
  exports: [SubmissionsService, CommentsService],
})
export class ValidationModule {}
