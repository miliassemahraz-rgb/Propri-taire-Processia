import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import { closeDb, createDb, resolveDbUrls, type Database } from '@processia/db';
import { ENV, envProvider } from '../env.js';

export const DB = Symbol('DB');

/** URL du rôle applicatif `processia_app` (non propriétaire, soumis à la RLS). */
export function appDatabaseUrl(env: Env): string {
  const urls = resolveDbUrls({
    NODE_ENV: env.NODE_ENV,
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_OWNER_URL: env.DATABASE_OWNER_URL,
    DATABASE_APP_URL: env.DATABASE_APP_URL,
  });
  return urls.app;
}

class DbLifecycle implements OnModuleDestroy {
  constructor(@Inject(DB) private readonly db: Database) {}
  async onModuleDestroy(): Promise<void> {
    await closeDb(this.db);
  }
}

/** Connexion unique à la base avec le rôle applicatif. */
@Global()
@Module({
  providers: [
    envProvider,
    {
      provide: DB,
      inject: [ENV],
      useFactory: (env: Env): Database => createDb(appDatabaseUrl(env)),
    },
    DbLifecycle,
  ],
  exports: [DB, ENV],
})
export class DbModule {}
