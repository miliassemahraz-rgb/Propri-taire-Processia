import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ModelModule } from '../model/model.module.js';
import { DiagnosticController } from './diagnostic.controller.js';
import { DiagnosticService } from './diagnostic.service.js';

/** Diagnostic de l'AS-IS validé : détecteurs déterministes et pipeline `diagnostic` (WP-21). */
@Module({
  imports: [AuthModule, AiModule, ModelModule],
  controllers: [DiagnosticController],
  providers: [DiagnosticService],
  exports: [DiagnosticService],
})
export class DiagnosticModule {}
