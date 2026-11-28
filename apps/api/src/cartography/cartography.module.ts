import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ModelModule } from '../model/model.module.js';
import { CartographyController } from './cartography.controller.js';
import { CartographyService } from './cartography.service.js';

/** Cartographie en lecture : BPMN des diagrammes pour la visionneuse (WP-19). */
@Module({
  imports: [AuthModule, ModelModule],
  controllers: [CartographyController],
  providers: [CartographyService],
  exports: [CartographyService],
})
export class CartographyModule {}
