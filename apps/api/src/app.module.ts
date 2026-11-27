import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module.js';
import { AnalysisModule } from './analysis/analysis.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ClientsModule } from './clients/clients.module.js';
import { CollabModule } from './collab/collab.module.js';
import { DbModule } from './db/db.module.js';
import { ExportsModule } from './exports/exports.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { HealthModule } from './health/health.module.js';
import { MissionsModule } from './missions/missions.module.js';
import { ModelModule } from './model/model.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PolicyModule } from './policy/policy.module.js';
import { SourcesModule } from './sources/sources.module.js';
import { UsersModule } from './users/users.module.js';
import { ValidationModule } from './validation/validation.module.js';

@Module({
  imports: [
    DbModule,
    AuthModule,
    PolicyModule,
    UsersModule,
    ClientsModule,
    MissionsModule,
    ModelModule,
    CollabModule,
    AiModule,
    JobsModule,
    SourcesModule,
    AnalysisModule,
    ExportsModule,
    NotificationsModule,
    ValidationModule,
    HealthModule,
  ],
})
export class AppModule {}
