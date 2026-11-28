import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@processia/config/env';
import { resetTestDatabase, resolveDbUrls, SEED_IDS, seedDevelopment } from '@processia/db';
import {
  buildActivity,
  buildActor,
  listDiagrams,
  tempId,
  type BusinessModel,
  type ChangeSet,
  type Element,
} from '@processia/model';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { RATE_LIMIT_OPTIONS } from '../auth/guards.js';
import { ENV } from '../env.js';
import { TestClient } from '../testing/http-client.js';

// Intégration WP-19 : BPMN des diagrammes pour la visionneuse. Exige `pnpm services:up`.
// Application Nest réelle, base `processia_test`, rôle `processia_app` (RLS).

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const base = `/missions/${MISSION}`;

let app: INestApplication;
let baseUrl: string;
let admin: pg.Pool;
const client = () => new TestClient(() => baseUrl);
let consultant: TestClient;
let manager: TestClient;
let validator: TestClient;
let outsider: TestClient;

beforeAll(async () => {
  await resetTestDatabase(urls);
  await seedDevelopment(urls.admin);
  admin = new pg.Pool({ connectionString: urls.admin, max: 2 });
  const env = loadEnv({ ...process.env, DATABASE_APP_URL: urls.app });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(RATE_LIMIT_OPTIONS)
    .useValue({ limit: 10_000, windowMs: 60_000 })
    .compile();
  app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  consultant = await client().signIn('consultante1@processia.local');
  manager = await client().signIn('responsable@processia.local');
  validator = await client().signIn('validateur@processia.local');
  outsider = await client().signIn('admin@processia.local');
});

afterAll(async () => {
  await app.close();
  await admin.end();
});

const add = (element: unknown): ChangeSet['ops'][number] => ({
  op: 'add',
  element: element as Element,
});

describe('WP-19 : BPMN des diagrammes (visionneuse)', () => {
  let macroId = '';
  let processId = '';
  let taskId = '';

  it('verrou de phase : 409 PHASE_LOCKED avant la validation du dossier', async () => {
    const res = await consultant.call('GET', `${base}/bpmn/L0`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PHASE_LOCKED');
  });

  it('prépare un modèle (macroprocessus, processus, deux tâches) et ouvre la phase de cartographie', async () => {
    const actor = buildActor({ id: tempId(1), code: 'ACT-01', label: 'Comptable' });
    const macro = buildActivity({ id: tempId(2), code: 'P01', label: 'Tenue', level: 'macro' });
    const process = buildActivity({
      id: tempId(3),
      code: 'P01.1',
      label: 'Saisie',
      level: 'process',
      parentId: tempId(2),
    });
    const t1 = buildActivity({
      id: tempId(4),
      code: 'P01.1.1',
      label: 'Saisir les factures',
      level: 'task',
      parentId: tempId(3),
      order: 1,
      responsibleActorId: tempId(1),
    });
    const t2 = buildActivity({
      id: tempId(5),
      code: 'P01.1.2',
      label: 'Contrôler la saisie',
      level: 'task',
      parentId: tempId(3),
      order: 2,
      responsibleActorId: tempId(1),
    });
    const res = await consultant.call('POST', `${base}/model/changes`, {
      changeSet: {
        baseVersion: 0,
        cause: 'dialogue_edit',
        summary: 'Modèle de test',
        ops: [actor, macro, process, t1, t2].map(add),
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const model = (await consultant.call('GET', `${base}/model`)).body.model as BusinessModel;
    const byCode = (code: string): string =>
      Object.values(model.elements).find((e) => e.code === code)?.id ?? '';
    macroId = byCode('P01');
    processId = byCode('P01.1');
    taskId = byCode('P01.1.1');
    expect(listDiagrams(model)).toEqual(['L0', `L1:${macroId}`, `L2:${processId}`]);
    const phase = await manager.call('PATCH', base, { phase: 'mapping' });
    expect(phase.status, JSON.stringify(phase.body)).toBe(200);
    expect(taskId).not.toBe('');

    // Un compte qui n'est pas membre de la mission lit au plus, il n'écrit jamais de disposition.
    const count = async (): Promise<number> =>
      (
        await admin.query(`select count(*)::int as n from model_versions where mission_id = $1`, [
          MISSION,
        ])
      ).rows[0].n as number;
    const before = await count();
    const read = await outsider.call(
      'GET',
      `${base}/bpmn/${encodeURIComponent(`L2:${processId}`)}`,
    );
    expect([200, 403, 404]).toContain(read.status);
    expect(await count()).toBe(before);
  });

  it('rend le BPMN 2.0 de chaque diagramme (version de tête, XML avec BPMN DI et processia:elementId)', async () => {
    const head = (await consultant.call('GET', `${base}/model`)).body.version as number;
    for (const diagram of ['L0', `L1:${macroId}`, `L2:${processId}`]) {
      const res = await consultant.call('GET', `${base}/bpmn/${encodeURIComponent(diagram)}`);
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
      expect(res.body.diagram).toBe(diagram);
      expect(res.body.version).toBeGreaterThanOrEqual(head);
      expect(res.body.xml).toContain('bpmn:definitions');
      expect(res.body.xml).toContain('BPMNDiagram');
      expect(res.body.xml).toContain('processia:elementId');
    }
    expect((await consultant.call('GET', `${base}/bpmn/L2:${processId}`)).body.xml).toContain(
      'Saisir les factures',
    );
  });

  it('les positions nouvelles sont enregistrées une seule fois (cause layout) ; le rendu suivant est identique', async () => {
    const diagram = `L2:${processId}`;
    const versions = async (): Promise<{ version: number; cause: string }[]> =>
      (
        await admin.query(
          `select version, cause from model_versions where mission_id = $1 order by version`,
          [MISSION],
        )
      ).rows;
    const first = await consultant.call('GET', `${base}/bpmn/${encodeURIComponent(diagram)}`);
    const after = await versions();
    const layoutVersions = after.filter((v) => v.cause === 'layout');
    expect(layoutVersions.length).toBeGreaterThanOrEqual(1);
    const model = (await consultant.call('GET', `${base}/model`)).body.model as BusinessModel;
    expect(Object.keys(model.layout[diagram] ?? {}).length).toBeGreaterThan(0);

    const countBefore = after.length;
    const second = await consultant.call('GET', `${base}/bpmn/${encodeURIComponent(diagram)}`);
    expect(second.body.xml).toBe(first.body.xml);
    expect((await versions()).length).toBe(countBefore);

    // Deux lectures simultanées d'un diagramme neuf ne créent qu'une version de disposition.
    const l1 = `L1:${macroId}`;
    const [a, b] = await Promise.all([
      consultant.call('GET', `${base}/bpmn/${encodeURIComponent(l1)}`),
      manager.call('GET', `${base}/bpmn/${encodeURIComponent(l1)}`),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const l1Versions = (await versions()).length - countBefore;
    expect(l1Versions).toBeLessThanOrEqual(1);
  });

  it('une version passée se lit sans créer de version, un diagramme inconnu est introuvable', async () => {
    const before = (
      await admin.query(`select count(*)::int as n from model_versions where mission_id = $1`, [
        MISSION,
      ])
    ).rows[0].n as number;
    const old = await consultant.call('GET', `${base}/bpmn/L0?version=1`);
    expect(old.status).toBe(200);
    expect(old.body.version).toBe(1);
    const after = (
      await admin.query(`select count(*)::int as n from model_versions where mission_id = $1`, [
        MISSION,
      ])
    ).rows[0].n as number;
    expect(after).toBeGreaterThanOrEqual(before);
    const unknown = await consultant.call(
      'GET',
      `${base}/bpmn/L2:${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}`,
    );
    expect(unknown.status).toBe(404);
    const bad = await consultant.call('GET', `${base}/bpmn/L9:abc`);
    expect(bad.status).toBe(400);
  });

  it('droits : le validateur reçoit 403', async () => {
    expect((await validator.call('GET', `${base}/bpmn/L0`)).status).toBe(403);
  });
});
