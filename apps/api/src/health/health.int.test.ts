import { loadEnv } from '@processia/config/env';
import { afterAll, describe, expect, it } from 'vitest';
import { HealthService } from './health.service.js';
import { DbProbe, S3Probe } from './probes.js';

// Test d'intégration : exige `docker compose up -d` (postgres, minio) et les variables
// d'environnement de `.env.example` (chargées par vitest.int.config.ts).
const env = loadEnv();
const db = new DbProbe(env);
const s3 = new S3Probe(env);

afterAll(async () => {
  await db.onModuleDestroy();
  s3.onModuleDestroy();
});

describe('santé avec les vrais services', () => {
  it('trouve la base et les buckets S3', async () => {
    await expect(new HealthService(db, s3).check()).resolves.toEqual({ db: 'ok', s3: 'ok' });
  });
});
