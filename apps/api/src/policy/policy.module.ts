import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module.js';
import { PolicyGuard } from './policy.guard.js';

/** Droits (`@Can`), cloisonnement par mission (`MissionGuard`) et contexte de mission (WP-06). */
@Module({
  // AuthModule d'abord : sa garde de session doit précéder celle des droits.
  imports: [AuthModule],
  providers: [{ provide: APP_GUARD, useClass: PolicyGuard }],
})
export class PolicyModule {}
