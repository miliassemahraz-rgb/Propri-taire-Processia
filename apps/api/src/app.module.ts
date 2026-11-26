import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { ClientsModule } from './clients/clients.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { MissionsModule } from './missions/missions.module.js';
import { ModelModule } from './model/model.module.js';
import { PolicyModule } from './policy/policy.module.js';
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
    HealthModule,
  ],
})
export class AppModule {}
