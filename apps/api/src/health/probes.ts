import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import pg from 'pg';
import { ENV } from '../env.js';

const PROBE_TIMEOUT_MS = 3000;

/** Une sonde vérifie qu'une dépendance répond ; elle lève une erreur sinon. */
export interface Probe {
  check(): Promise<void>;
}

@Injectable()
export class DbProbe implements Probe, OnModuleDestroy {
  private readonly pool: pg.Pool;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    });
    // Une connexion inactive qui se ferme ne doit pas faire tomber le processus.
    this.pool.on('error', () => undefined);
  }

  async check(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Injectable()
export class S3Probe implements Probe, OnModuleDestroy {
  private readonly client: S3Client;
  private readonly buckets: string[];

  constructor(@Inject(ENV) env: Env) {
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
      maxAttempts: 1,
    });
    this.buckets = [env.S3_BUCKET_SOURCES, env.S3_BUCKET_ARTIFACTS];
  }

  async check(): Promise<void> {
    for (const bucket of this.buckets) {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }), {
        abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
