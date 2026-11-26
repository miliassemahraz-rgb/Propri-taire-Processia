import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { MissionsController } from './missions.controller.js';
import { MissionsService } from './missions.service.js';

/** Missions, affectations, phase et tableau de suivi (WP-06). */
@Module({
  imports: [AuthModule, ClientsModule],
  controllers: [MissionsController],
  providers: [MissionsService],
})
export class MissionsModule {}
