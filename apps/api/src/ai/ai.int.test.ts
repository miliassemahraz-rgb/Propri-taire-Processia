import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import {
  AiBudgetExceeded,
  AiConfigError,
  demoSummaryPipeline,
  type PipelineDef,
} from '@processia/ai';
import { loadEnv } from '@processia/config/env';
import {
  aiCalls,
  resetTestDatabase,
  resolveDbUrls,
  SEED_IDS,
  seedDevelopment,
  withMission,
  withoutMission,
} from '@processia/db';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { encryptSecret } from '../auth/crypto.js';
import { KEY_PURPOSE } from '../clients/ai-config.service.js';
import { DB } from '../db/db.module.js';
import { ENV } from '../env.js';
import { AiProviderRegistry } from './ai-provider.registry.js';
import { AiService } from './ai.service.js';
import type { Database } from '@processia/db';
import type { INestApplication } from '@nestjs/common';

// Intégration : exige `pnpm services:up`. Journal `ai_calls` sous RLS, budget mensuel, registre.

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const CLIENT = SEED_IDS.client;
const valid = { summary: 'Résumé.', keywords: ['k'] };

let app: INestApplication;
let admin: pg.Pool;
let db: Database;
let ai: AiService;
let registry: AiProviderRegistry;
let masterKey: string;
let server: Server;
let hits: { model: string; auth: string }[];

beforeAll(async () => {
  await resetTestDatabase(urls);
  await seedDevelopment(urls.admin);
  admin = new pg.Pool({ connectionString: urls.admin, max: 2 });
  // Serveur HTTP simulé du fournisseur : aucun appel réel.
  hits = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
      hits.push({ model: body.model, auth: JSON.stringify(req.headers) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: JSON.stringify(valid) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = loadEnv({
    ...process.env,
    DATABASE_APP_URL: urls.app,
    AI_BASE_URL: baseUrl,
    // 1 EUR par million de jetons d'entrée et de sortie multiplié : 15 jetons = 1,5 EUR.
    AI_PRICE_TABLE: JSON.stringify({
      default: { inputPerMTokEur: 100_000, outputPerMTokEur: 100_000 },
    }),
  });
  masterKey = env.MASTER_KEY;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  db = moduleRef.get<Database>(DB);
  ai = moduleRef.get(AiService);
  registry = moduleRef.get(AiProviderRegistry);
  registry.registerFakeScenario('demo.summary', () => valid);
});

afterAll(async () => {
  await app.close();
  await admin.end();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  hits.length = 0;
  await admin.query('delete from ai_calls');
  await admin.query('delete from ai_provider_configs');
  await admin.query("delete from audit_log where action = 'ai_budget.alert_80'");
});

async function configure(opts: {
  provider: 'fake' | 'anthropic';
  budget?: number;
  accepted?: boolean;
  key?: boolean;
  models?: Record<string, string>;
}): Promise<void> {
  await admin.query(
    `insert into ai_provider_configs
       (client_id, provider, models, api_key_enc, monthly_budget_eur, policy_accepted_at, data_policy_text)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      CLIENT,
      opts.provider,
      JSON.stringify(opts.models ?? {}),
      opts.key === false ? null : encryptSecret('sk-test-key-1234', masterKey, KEY_PURPOSE),
      opts.budget ?? 150,
      opts.accepted === false ? null : new Date(),
      'politique',
    ],
  );
}

async function seedSpend(eur: number, missionId: string | null): Promise<void> {
  await admin.query(
    `insert into ai_calls (mission_id, client_id, pipeline, pipeline_version, provider, model, input_hash, status, cost_estimate_eur)
     values ($1, $2, 'demo.summary', '1', 'anthropic', 'm', 'h', 'ok', $3)`,
    [missionId, CLIENT, eur],
  );
}

describe('WP-09 : journal, budget et registre côté API', () => {
  it('acceptation 1 : fournisseur factice par défaut, sortie validée, appel journalisé sous la mission', async () => {
    const run = await ai.run(demoSummaryPipeline, { text: 'Texte' }, { missionId: MISSION });
    expect(run.output).toEqual(valid);
    expect(run.callId).not.toBeNull();
    // Invisible sans contexte de mission (RLS), visible dans celui de la mission.
    expect(await withoutMission(db, (tx) => tx.select().from(aiCalls))).toHaveLength(0);
    const rows = await withMission(db, MISSION, (tx) => tx.select().from(aiCalls));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientId: CLIENT,
      pipeline: 'demo.summary',
      provider: 'fake',
      status: 'ok',
    });
    expect(JSON.stringify(rows[0]?.request)).toContain('Texte');
  });

  it('un appel sans mission n’est visible que par aiUnscoped', async () => {
    await ai.run(demoSummaryPipeline, { text: 'x' }, { clientId: CLIENT });
    expect(await withoutMission(db, (tx) => tx.select().from(aiCalls))).toHaveLength(0);
    const rows = await withoutMission(db, (tx) => tx.select().from(aiCalls), { aiUnscoped: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.missionId).toBeNull();
  });

  it('acceptation 3 : budget dépassé (toutes missions et appels hors mission), appel bloqué', async () => {
    await configure({ provider: 'fake', budget: 10 });
    await seedSpend(6, MISSION);
    await seedSpend(4, null);
    const err = await ai
      .run(demoSummaryPipeline, { text: 'x' }, { missionId: MISSION })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBudgetExceeded);
    expect((err as AiBudgetExceeded).spentEur).toBe(10);
    const rows = await withMission(db, MISSION, (tx) => tx.select().from(aiCalls));
    expect(rows).toHaveLength(1); // seule la ligne préexistante : aucun nouvel appel
  });

  it('sous le plafond : passe ; un appel d’un mois précédent ne compte pas', async () => {
    await configure({ provider: 'fake', budget: 10 });
    await admin.query(
      `insert into ai_calls (mission_id, client_id, pipeline, pipeline_version, provider, model, input_hash, status, cost_estimate_eur, created_at)
       values ($1, $2, 'p', '1', 'anthropic', 'm', 'h', 'ok', 500, now() - interval '70 days')`,
      [MISSION, CLIENT],
    );
    await expect(
      ai.run(demoSummaryPipeline, { text: 'x' }, { missionId: MISSION }),
    ).resolves.toBeDefined();
  });

  it('fournisseur Anthropic configuré : modèle de la configuration, clé déchiffrée, coût journalisé, alerte à 80 %', async () => {
    await configure({
      provider: 'anthropic',
      budget: 10,
      models: { default: 'light-model', other: 'main-model' },
    });
    await seedSpend(7, MISSION);
    const run = await ai.run(demoSummaryPipeline, { text: 'x' }, { missionId: MISSION });
    expect(hits).toEqual([
      { model: 'light-model', auth: expect.stringContaining('sk-test-key-1234') },
    ]);
    expect(run.costEstimateEur).toBe(1.5);
    const rows = await withMission(db, MISSION, (tx) => tx.select().from(aiCalls));
    const row = rows.find((r) => r.provider === 'anthropic' && r.inputHash !== 'h');
    expect(row).toMatchObject({ model: 'light-model', inputTokens: 10, outputTokens: 5 });
    expect(Number(row?.costEstimateEur)).toBe(1.5);
    const alerts = await admin.query("select * from audit_log where action = 'ai_budget.alert_80'");
    expect(alerts.rowCount).toBe(1);
    // Déjà au-delà de 80 % : pas de seconde alerte.
    await ai.run(demoSummaryPipeline, { text: 'y' }, { missionId: MISSION });
    const again = await admin.query("select * from audit_log where action = 'ai_budget.alert_80'");
    expect(again.rowCount).toBe(1);
  });

  it('modèle propre au pipeline prioritaire sur default', async () => {
    await configure({
      provider: 'anthropic',
      models: { default: 'light-model', 'demo.summary': 'main-model' },
    });
    await ai.run(demoSummaryPipeline, { text: 'x' }, { missionId: MISSION });
    expect(hits[0]?.model).toBe('main-model');
  });

  it('politique de données non acceptée : aucun appel réel', async () => {
    await configure({ provider: 'anthropic', accepted: false, models: { default: 'light-model' } });
    await expect(
      ai.run(demoSummaryPipeline, { text: 'x' }, { missionId: MISSION }),
    ).rejects.toBeInstanceOf(AiConfigError);
    expect(hits).toHaveLength(0);
  });

  it('sans clé : fournisseur factice ; AI_PROVIDER_OVERRIDE=fake force le factice', async () => {
    await configure({ provider: 'anthropic', key: false, models: { default: 'light-model' } });
    expect((await registry.forClient(CLIENT)).simulated).toBe(true);
    await configure({ provider: 'anthropic', models: { default: 'light-model' } });
    await admin.query('delete from ai_provider_configs where api_key_enc is null');
    expect((await registry.forClient(CLIENT)).simulated).toBe(false);
    const overridden = new AiProviderRegistry(
      { ...loadEnv({ ...process.env, DATABASE_APP_URL: urls.app }), AI_PROVIDER_OVERRIDE: 'fake' },
      (registry as unknown as { configs: never }).configs,
    );
    expect((await overridden.forClient(CLIENT)).simulated).toBe(true);
    expect(hits).toHaveLength(0);
  });

  it('échec journalisé : sortie hors schéma deux fois', async () => {
    const def: PipelineDef<{ t: string }, { n: number }> = {
      ...(demoSummaryPipeline as unknown as PipelineDef<{ t: string }, { n: number }>),
      name: 'bad.demo',
      buildRequest: () => ({ system: 's', messages: [{ role: 'user', content: 'u' }] }),
    };
    registry.registerFakeScenario('bad.demo', () => ({ n: 'x' }));
    await expect(ai.run(def, { t: '' }, { missionId: MISSION })).rejects.toThrow();
    const rows = await withMission(db, MISSION, (tx) => tx.select().from(aiCalls));
    expect(rows[0]).toMatchObject({ status: 'error', pipeline: 'bad.demo' });
    expect(rows[0]?.error).toContain('INVALID_OUTPUT');
  });
});
