import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FakeSimulation, type FakeScenario } from '@processia/ai';
import { loadEnv } from '@processia/config/env';
import type { ChunkDto, RunDto, SourceDto } from '@processia/contracts';
import { resetTestDatabase, resolveDbUrls, SEED_IDS, seedDevelopment } from '@processia/db';
import {
  ElementSchema,
  parseModel,
  type Activity,
  type Actor,
  type BusinessModel,
  type Discrepancy,
  type Element,
} from '@processia/model';
import {
  buildScannedPdf,
  PILOT_ACTORS,
  PILOT_DESCRIPTION,
  PILOT_MACROS,
  PILOT_SCANNED_DOCUMENT_NAME,
  PILOT_SCENARIOS,
  PILOT_STAKEHOLDERS,
} from '@processia/test-fixtures';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiProviderRegistry } from '../ai/ai-provider.registry.js';
import { AppModule } from '../app.module.js';
import { RATE_LIMIT_OPTIONS } from '../auth/guards.js';
import { ENV } from '../env.js';
import { JobsService } from '../jobs/jobs.service.js';
import { TestClient } from '../testing/http-client.js';

// Intégration WP-12 : exige `pnpm services:up`. Application Nest réelle sur HTTP, worker pg-boss
// dans le même processus, fournisseur IA factice avec le scénario du pilote.

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const base = `/missions/${MISSION}`;

let app: INestApplication;
let baseUrl: string;
let admin: pg.Pool;
let consultant: TestClient;
let validator: TestClient;
const client = () => new TestClient(() => baseUrl);

beforeAll(async () => {
  await resetTestDatabase(urls);
  await seedDevelopment(urls.admin);
  admin = new pg.Pool({ connectionString: urls.admin, max: 2 });
  const env = loadEnv({
    ...process.env,
    DATABASE_APP_URL: urls.app,
    DATABASE_OWNER_URL: urls.owner,
    AI_PROVIDER_OVERRIDE: 'fake',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(RATE_LIMIT_OPTIONS)
    .useValue({ limit: 10_000, windowMs: 60_000 })
    .compile();
  app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  await app.get(JobsService).startConsuming();
  consultant = await client().signIn('consultante1@processia.local');
  validator = await client().signIn('validateur@processia.local');
}, 60_000);

afterAll(async () => {
  await app.close();
  await admin.end();
});

/** Description du métier : un paragraphe Yjs par bloc de texte (document `workspace`). */
async function setDescription(text: string): Promise<void> {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('description');
  fragment.insert(
    0,
    text.split('\n\n').map((part) => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText(part)]);
      return p;
    }),
  );
  await admin.query(
    `insert into yjs_documents (name, mission_id, state) values ($1, $2, $3)
     on conflict (name) do update set state = excluded.state, updated_at = now()`,
    [`mission:${MISSION}:workspace`, MISSION, Buffer.from(Y.encodeStateAsUpdate(doc))],
  );
}

async function waitRun(runId: string): Promise<RunDto> {
  for (let i = 0; i < 300; i += 1) {
    const res = await consultant.call('GET', `${base}/runs/${runId}`);
    const run = res.body as RunDto;
    if (res.status === 200 && (run.status === 'succeeded' || run.status === 'failed')) return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Exécution non terminée.');
}

async function analyze(sourceId?: string): Promise<{ runId: string; source: SourceDto }> {
  const res = await consultant.call(
    'POST',
    `${base}/analysis/extractions`,
    sourceId === undefined ? {} : { sourceId },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { runId: string; source: SourceDto };
}

async function head(): Promise<{ version: number; model: BusinessModel }> {
  const res = await consultant.call('GET', `${base}/model`);
  expect(res.status).toBe(200);
  return res.body as { version: number; model: BusinessModel };
}

const list = (m: BusinessModel): Element[] => Object.values(m.elements);
const acts = (m: BusinessModel): Activity[] =>
  list(m).filter((e): e is Activity => e.kind === 'activity');

async function chunksOf(sourceId: string): Promise<Map<string, ChunkDto>> {
  const res = await consultant.call('GET', `${base}/sources/${sourceId}/chunks`);
  expect(res.status).toBe(200);
  return new Map((res.body as ChunkDto[]).map((c) => [c.id, c]));
}

async function lastExtractionNotification(): Promise<Record<string, number | string>> {
  const { rows } = await admin.query<{ payload: Record<string, number | string> }>(
    `select payload from notifications where mission_id = $1 and kind = 'analysis.extraction_done'
     order by created_at desc, id desc limit 1`,
    [MISSION],
  );
  return rows[0]?.payload ?? {};
}

let pilotSourceId = '';

describe('WP-12 : extraction, réconciliation, écarts', () => {
  it('droits : le validateur ne peut pas analyser, une description vide est refusée', async () => {
    expect((await validator.call('POST', `${base}/analysis/extractions`, {})).status).toBe(403);
    const empty = await consultant.call('POST', `${base}/analysis/extractions`, {});
    expect(empty.status).toBe(400);
  });

  it('1. la description du pilote produit les 14 macroprocessus, 8 acteurs, 4 parties prenantes', async () => {
    await setDescription(PILOT_DESCRIPTION);
    const started = await analyze();
    pilotSourceId = started.source.id;
    expect(started.source).toMatchObject({ kind: 'free_text', revision: 1 });
    const run = await waitRun(started.runId);
    expect(run, JSON.stringify(run)).toMatchObject({
      kind: 'extraction',
      status: 'succeeded',
      progress: 100,
      resultVersion: 1,
    });

    const { version, model } = await head();
    expect(version).toBe(1);
    const macros = acts(model).filter((a) => a.level === 'macro');
    expect(macros.map((a) => a.code).sort()).toEqual(PILOT_MACROS.map((m) => m.code).sort());
    const chunks = await chunksOf(pilotSourceId);
    for (const expected of PILOT_MACROS) {
      const macro = macros.find((a) => a.code === expected.code) as Activity;
      expect(macro.label).toBe(expected.label);
      expect(macro.scope).toBe(expected.scope);
      expect(macro.status.value).toBe('extracted');
      // L'ordre du JSONB n'est pas celui d'insertion : le champ `order` porte l'ordre de la source.
      const children = acts(model)
        .filter((a) => a.parentId === macro.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      expect(children.map((c) => c.label)).toEqual(expected.activities.map((x) => x.label));
      expect(children.every((c) => c.level === 'process')).toBe(true);
    }
    const actors = list(model).filter((e): e is Actor => e.kind === 'actor');
    expect(
      actors
        .filter((a) => a.stakeholder !== true)
        .map((a) => a.label)
        .sort(),
    ).toEqual(PILOT_ACTORS.map((a) => a.label).sort());
    expect(
      actors
        .filter((a) => a.stakeholder === true)
        .map((a) => a.label)
        .sort(),
    ).toEqual(PILOT_STAKEHOLDERS.map((a) => a.label).sort());

    // Les citations sont vérifiées contre le texte des morceaux, aux positions annoncées.
    const aiCalls = await admin.query<{ id: string; pipeline: string }>(
      'select id, pipeline from ai_calls where mission_id = $1',
      [MISSION],
    );
    const callIds = new Set(aiCalls.rows.map((r) => r.id));
    expect(aiCalls.rows.every((r) => r.pipeline === 'extraction.chunk')).toBe(true);
    for (const el of list(model)) {
      expect(el.status.value).toBe('extracted');
      expect(el.provenance.author.type).toBe('ai');
      expect(el.provenance.refs.length).toBeGreaterThan(0);
      expect(callIds.has(el.provenance.aiCallId ?? '')).toBe(true);
      for (const ref of el.provenance.refs) {
        const chunk = chunks.get(ref.chunkId ?? '');
        expect(chunk, `morceau de ${el.code}`).toBeDefined();
        expect(chunk?.text.slice(ref.locator.charStart, ref.locator.charEnd)).toBe(ref.quote);
        expect(ref.sourceId).toBe(pilotSourceId);
        expect(ref.sourceRevision).toBe(1);
        expect(ref.locator.paragraph).toBeGreaterThanOrEqual(1);
      }
    }

    // La version porte la cause « extraction », l'auteur et l'appel IA ; la notification, les compteurs.
    const versions = await admin.query(
      `select cause, author_id, ai_call_id from model_versions where mission_id = $1 and version = 1`,
      [MISSION],
    );
    expect(versions.rows[0]).toMatchObject({
      cause: 'extraction',
      author_id: SEED_IDS.consultantA,
    });
    expect(callIds.has(versions.rows[0]?.ai_call_id)).toBe(true);
    expect(await lastExtractionNotification()).toMatchObject({
      sourceId: pilotSourceId,
      version: 1,
      created: list(model).length,
      extracted: list(model).length,
      hypotheses: 0,
      citationsDemoted: 0,
      discrepancies: 0,
    });
  });

  it('4. chaque élément créé a une provenance valide : le modèle produit passe la validation du schéma', async () => {
    const { model } = await head();
    for (const el of list(model)) {
      const parsed = ElementSchema.safeParse(el);
      expect(parsed.success, `${el.code} : ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
    expect(parseModel(model).ok).toBe(true);
    const snapshot = await admin.query<{ snapshot: unknown }>(
      'select snapshot from model_versions where mission_id = $1 and version = 1',
      [MISSION],
    );
    expect(parseModel(snapshot.rows[0]?.snapshot).ok).toBe(true);
  });

  it('3. relancer l’extraction sur la même source ne crée pas de doublons', async () => {
    const before = await head();
    const run = await waitRun((await analyze(pilotSourceId)).runId);
    expect(run.status).toBe('succeeded');
    expect(run.resultVersion).toBe(before.version);
    const after = await head();
    expect(after.version).toBe(before.version);
    expect(list(after.model)).toHaveLength(list(before.model).length);
    expect(await lastExtractionNotification()).toMatchObject({
      created: 0,
      matched: list(before.model).length,
      refsAdded: 0,
    });
    // Une nouvelle révision de la description corrobore les éléments sans les dupliquer.
    const again = await analyze();
    expect(again.source.revision).toBe(2);
    expect((await waitRun(again.runId)).status).toBe('succeeded');
    const corroborated = await head();
    expect(corroborated.version).toBe(before.version + 1);
    expect(list(corroborated.model)).toHaveLength(list(before.model).length);
    const macro = acts(corroborated.model).find((a) => a.code === 'P01') as Activity;
    expect(macro.provenance.refs.map((r) => r.sourceRevision)).toEqual([1, 2]);
    expect(macro.status.value).toBe('extracted');
  });

  it('1 (suite). un second document contradictoire (PDF scanné, extraction visuelle) produit un écart', async () => {
    // L'extraction visuelle exige un fournisseur doté de la capacité « documents ».
    await admin.query(
      `insert into ai_provider_configs (client_id, provider, models, capabilities, active)
       values ($1, 'fake', '{"default":"modele-factice"}', '{"text":true,"documents":true,"audio":false}', true)`,
      [SEED_IDS.client],
    );
    const before = await head();
    const res = await consultant.upload(
      `${base}/sources/documents`,
      PILOT_SCANNED_DOCUMENT_NAME,
      buildScannedPdf(1),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const second = res.body as { source: SourceDto; runId: string };
    expect((await waitRun(second.runId)).status).toBe('succeeded');
    const detail = await consultant.call('GET', `${base}/sources/${second.source.id}`);
    expect(detail.body.textStatus).toBe('extracted');

    const run = await waitRun((await analyze(second.source.id)).runId);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    const { version, model } = await head();
    expect(version).toBe(before.version + 1);
    const gaps = list(model).filter((e): e is Discrepancy => e.kind === 'discrepancy');
    expect(gaps).toHaveLength(1);
    const gap = gaps[0] as Discrepancy;
    expect(gap).toMatchObject({ state: 'open', status: { value: 'extracted' } });
    expect(gap.sides).toHaveLength(2);
    expect(gap.sides[0]?.claim).toContain('Assistant administratif');
    expect(gap.sides[1]?.claim).toContain('Collaborateur comptable');
    expect(gap.sides[1]?.refs[0]?.sourceId).toBe(second.source.id);
    // L'élément n'est pas tranché ni dupliqué : il reste une seule activité « Relances clients ».
    const relances = acts(model).filter((a) => a.label === 'Relances clients');
    expect(relances).toHaveLength(1);
    expect(gap.elementIds).toEqual([relances[0]?.id]);
    expect(list(model)).toHaveLength(list(before.model).length + 1);
    // L'écart est signalé une seule fois, même si l'extraction est relancée.
    const rerun = await waitRun((await analyze(second.source.id)).runId);
    expect(rerun.status).toBe('succeeded');
    const final = await head();
    expect(final.version).toBe(version);
    expect(list(final.model).filter((e) => e.kind === 'discrepancy')).toHaveLength(1);
    // Les deux appels IA de la seconde source sont journalisés (transcription, extraction, réconciliation).
    const pipelines = await admin.query<{ pipeline: string }>(
      'select distinct pipeline from ai_calls where mission_id = $1',
      [MISSION],
    );
    expect(pipelines.rows.map((r) => r.pipeline).sort()).toEqual([
      'extraction.chunk',
      'extraction.document_visual',
      'reconcile',
    ]);
  });

  it('2. une citation altérée est rétrogradée en hypothèse', async () => {
    const registry = app.get(AiProviderRegistry);
    // Le « modèle » invente une citation absente de la source.
    registry.registerFakeScenario('extraction.chunk', (req) => {
      const content = req.messages.find((m) => m.role === 'user')?.content ?? '';
      const chunkId = /<morceau id="([^"]+)"/.exec(content)?.[1] ?? '';
      return {
        candidates: [
          {
            ref: 'c1',
            chunkId,
            kind: 'activity',
            label: 'Archivage numérique',
            code: 'P15',
            quote: 'Le processus P15 couvre l’archivage numérique de tous les dossiers.',
            activity: { level: 'macro', scope: 'mapping_only' },
          },
          {
            ref: 'c2',
            chunkId,
            kind: 'activity',
            label: 'Numérisation du courrier',
            quote: 'la numérisation du courrier',
            activity: { level: 'process', parent: 'c1' },
          },
        ],
      };
    });
    try {
      await setDescription(
        'Le cabinet souhaite aussi suivre la numérisation du courrier entrant, sans plus de détail.',
      );
      const before = await head();
      const run = await waitRun((await analyze()).runId);
      expect(run.status, JSON.stringify(run)).toBe('succeeded');
      const { model } = await head();
      const macro = acts(model).find((a) => a.label === 'Archivage numérique') as Activity;
      expect(macro.status.value).toBe('hypothesis');
      expect(macro.provenance.rationale).toMatch(/Citation non retrouvée dans la source/);
      expect(macro.provenance.refs).toEqual([]);
      expect(macro.provenance.origin).toBe('ai_knowledge');
      expect(macro.code).toBe('P15');
      const child = acts(model).find((a) => a.label === 'Numérisation du courrier') as Activity;
      expect(child.status.value).toBe('extracted');
      expect(child.parentId).toBe(macro.id);
      expect(child.code).toBe('P15.1');
      expect(list(model)).toHaveLength(list(before.model).length + 2);
      const notice = await lastExtractionNotification();
      expect(notice).toMatchObject({ citationsDemoted: 1, hypotheses: 1, extracted: 1 });
      // Aucun élément n'est jamais créé « confirmé » par l'IA.
      expect(list(model).some((e) => e.status.value === 'confirmed')).toBe(false);
    } finally {
      registry.registerFakeScenario(
        'extraction.chunk',
        PILOT_SCENARIOS['extraction.chunk'] as FakeScenario,
      );
    }
  });

  it('une analyse déjà en cours est refusée (409), un échec de l’IA est signalé', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into analysis_runs (mission_id, kind, status, progress) values ($1, 'extraction', 'running', 10) returning id`,
      [MISSION],
    );
    const busy = await consultant.call('POST', `${base}/analysis/extractions`, {
      sourceId: pilotSourceId,
    });
    expect(busy.status).toBe(409);
    expect(busy.body.details).toEqual({ reason: 'ANALYSIS_IN_PROGRESS' });
    await admin.query('delete from analysis_runs where id = $1', [rows[0]?.id]);

    // Refus du fournisseur : l'exécution échoue avec le code de l'erreur, le modèle est inchangé.
    const registry = app.get(AiProviderRegistry);
    registry.registerFakeScenario('extraction.chunk', () => FakeSimulation.refusal());
    try {
      const before = await head();
      const run = await waitRun((await analyze(pilotSourceId)).runId);
      expect(run).toMatchObject({ status: 'failed', error: 'REFUSAL' });
      expect((await head()).version).toBe(before.version);
      const note = await admin.query(
        `select 1 from notifications where mission_id = $1 and kind = 'analysis.failed'`,
        [MISSION],
      );
      expect(note.rowCount).toBe(1);
    } finally {
      registry.registerFakeScenario(
        'extraction.chunk',
        PILOT_SCENARIOS['extraction.chunk'] as FakeScenario,
      );
    }
  });
});
