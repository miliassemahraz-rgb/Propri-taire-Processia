import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ClientsModule } from './clients/clients.module.js';
import { DbModule } from './db/db.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { HealthModule } from './health/health.module.js';
import { MissionsModule } from './missions/missions.module.js';
import { ModelModule } from './model/model.module.js';
import { PolicyModule } from './policy/policy.module.js';
import { SourcesModule } from './sources/sources.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    DbModule,
    AuthModule,
    PolicyModule,
    UsersModule,
    ClientsModule,
    MissionsModule,
    ModelModule,
    AiModule,
    JobsModule,
    SourcesModule,
    HealthModule,
  ],
})
export class AppModule {}
