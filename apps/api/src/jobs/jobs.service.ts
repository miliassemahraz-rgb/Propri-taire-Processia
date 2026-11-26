import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import { resolveDbUrls } from '@processia/db';
import { PgBoss, type SendOptions } from 'pg-boss';
import { ENV } from '../env.js';

/** Nom des files pg-boss (une par type de tâche, spécification 1.3 `JobsModule`). */
export const JOB_QUEUES = {
  ingestDocument: 'ingest.document',
  analysisExtraction: 'analysis.extraction',
} as const;
export type JobQueue = (typeof JOB_QUEUES)[keyof typeof JOB_QUEUES];

export type JobHandler = (data: unknown, jobId: string) => Promise<void>;

/** Schéma PostgreSQL de pg-boss (ADR 0016). */
export const PGBOSS_SCHEMA = 'pgboss';

/**
 * Producteur et consommateur pg-boss (ADR 0005 et 0016). Le démarrage est paresseux : le premier
 * `send` ou `startConsuming` crée le schéma `pgboss` et les files. Le processus HTTP ne fait que
 * produire ; seul le worker (`worker.ts`) appelle `startConsuming()`.
 */
@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private boss: PgBoss | undefined;
  private starting: Promise<PgBoss> | undefined;
  private readonly consumers = new Map<JobQueue, JobHandler>();

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Enregistre le traitement d'une file ; il ne démarre qu'avec `startConsuming()`. */
  addConsumer(queue: JobQueue, handler: JobHandler): void {
    this.consumers.set(queue, handler);
  }

  async send(queue: JobQueue, data: object, options: SendOptions = {}): Promise<string | null> {
    const boss = await this.ensureStarted();
    return boss.send(queue, data, options);
  }

  /** Démarre la consommation de toutes les files enregistrées (processus worker). */
  async startConsuming(): Promise<void> {
    const boss = await this.ensureStarted();
    for (const [queue, handler] of this.consumers) {
      await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
        for (const job of jobs) await handler(job.data, job.id);
      });
    }
  }

  private ensureStarted(): Promise<PgBoss> {
    this.starting ??= this.start();
    return this.starting;
  }

  private async start(): Promise<PgBoss> {
    // Le schéma de pg-boss est créé et migré par le rôle propriétaire ; il ne contient aucune
    // donnée de mission (pas de RLS), les données utiles passent en identifiants.
    const urls = resolveDbUrls({
      NODE_ENV: this.env.NODE_ENV,
      DATABASE_URL: this.env.DATABASE_URL,
      DATABASE_OWNER_URL: this.env.DATABASE_OWNER_URL,
      DATABASE_APP_URL: this.env.DATABASE_APP_URL,
    });
    const boss = new PgBoss({ connectionString: urls.owner, schema: PGBOSS_SCHEMA, max: 4 });
    boss.on('error', (error: Error) => this.logger.error(error.message));
    await boss.start();
    for (const queue of Object.values(JOB_QUEUES)) {
      await boss.createQueue(queue, { retryLimit: 2, retryDelay: 5, retryBackoff: true });
    }
    this.boss = boss;
    return boss;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.boss !== undefined) await this.boss.stop({ graceful: true, timeout: 5000 });
  }
}
