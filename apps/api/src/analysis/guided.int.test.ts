import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FakeSimulation, type FakeScenario } from '@processia/ai';
import { loadEnv } from '@processia/config/env';
import type {
  AnswerQuestionResult,
  ChunkDto,
  DecisionResult,
  QuestionDto,
  RunDto,
} from '@processia/contracts';
import { resetTestDatabase, resolveDbUrls, SEED_IDS, seedDevelopment } from '@processia/db';
import {
  completeness,
  parseModel,
  type Activity,
  type BusinessModel,
  type BusinessTrait,
  type Element,
} from '@processia/model';
import {
  PILOT_ANSWER_ENVIRONMENT,
  PILOT_ANSWER_SAISIE,
  PILOT_DESCRIPTION,
  PILOT_HYPOTHESES,
  PILOT_QUESTION_ENVIRONMENT,
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

// Intégration WP-14 : exige `pnpm services:up`. Application Nest réelle sur HTTP, worker pg-boss
// dans le même processus, fournisseur IA factice avec les scénarios du pilote.

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const base = `/missions/${MISSION}`;

let app: INestApplication;
let baseUrl: string;
let admin: pg.Pool;
let registry: AiProviderRegistry;
let consultantA: TestClient;
let consultantB: TestClient;
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
  registry = app.get(AiProviderRegistry);
  await app.get(JobsService).startConsuming();
  consultantA = await client().signIn('consultante1@processia.local');
  consultantB = await client().signIn('consultant2@processia.local');
  validator = await client().signIn('validateur@processia.local');
}, 60_000);

afterAll(async () => {
  await app.close();
  await admin.end();
});

async function setDescription(text: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getXmlFragment('description').insert(
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
    const res = await consultantA.call('GET', `${base}/runs/${runId}`);
    const run = res.body as RunDto;
    if (res.status === 200 && (run.status === 'succeeded' || run.status === 'failed')) return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Exécution non terminée.');
}

async function head(): Promise<{ version: number; model: BusinessModel }> {
  const res = await consultantA.call('GET', `${base}/model`);
  expect(res.status).toBe(200);
  return res.body as { version: number; model: BusinessModel };
}

const list = (m: BusinessModel): Element[] => Object.values(m.elements);
const byLabel = (m: BusinessModel, label: string): Element | undefined =>
  list(m).find((e) => e.label === label);

async function run(path: string): Promise<RunDto> {
  const res = await consultantA.call('POST', `${base}/${path}`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const done = await waitRun((res.body as { runId: string }).runId);
  expect(done, JSON.stringify(done)).toMatchObject({ status: 'succeeded' });
  return done;
}

async function questionsList(): Promise<QuestionDto[]> {
  const res = await consultantA.call('GET', `${base}/questions`);
  expect(res.status).toBe(200);
  return res.body as QuestionDto[];
}

const decide = (client: TestClient, id: string, body: unknown) =>
  client.call('POST', `${base}/elements/${id}/decision`, body);

describe('WP-14 : questionnement guidé et hypothèses', () => {
  it('prépare le modèle du pilote par « Analyser »', async () => {
    await setDescription(PILOT_DESCRIPTION);
    const res = await consultantA.call('POST', `${base}/analysis/extractions`, {});
    expect(res.status).toBe(201);
    expect((await waitRun(res.body.runId)).status).toBe('succeeded');
    expect((await head()).version).toBe(1);
  });

  it('droits : le validateur ne génère, ne répond et ne décide rien', async () => {
    expect((await validator.call('POST', `${base}/questions/generate`, {})).status).toBe(403);
    expect((await validator.call('POST', `${base}/hypotheses/generate`, {})).status).toBe(403);
    expect((await validator.call('POST', `${base}/questions/stop`, {})).status).toBe(403);
    const { model } = await head();
    expect((await decide(validator, (list(model)[0] as Element).id, { decision: 'accept' })).status).toBe(
      403,
    );
  });

  let first: QuestionDto;
  let ranked: QuestionDto[];

  it('1. questions : classées, la première a le blockingScore le plus élevé', async () => {
    const generated = await run('questions/generate');
    expect(generated.kind).toBe('questions');
    ranked = await questionsList();
    expect(ranked.length).toBeGreaterThanOrEqual(5);
    expect(ranked.every((q) => q.status === 'open')).toBe(true);
    first = ranked[0] as QuestionDto;
    const scores = ranked.map((q) => q.blockingScore ?? 0);
    expect(first.blockingScore).toBe(Math.max(...scores));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(ranked.map((q) => q.rank)).toEqual(ranked.map((_, i) => i + 1));
    expect(first.text).toBe(PILOT_QUESTION_ENVIRONMENT);
    expect(first.concept).toBe('business');
    // Les éléments visés sont résolus en identifiants du modèle.
    const { model } = await head();
    const saisie = ranked.find((q) => q.text.includes('« Saisie »')) as QuestionDto;
    expect(saisie.targetElementIds).toHaveLength(1);
    expect(model.elements[saisie.targetElementIds[0] as string]?.label).toBe('Saisie');
    // Relancer le pipeline ne repose jamais une question déjà posée : la liste complète est sans doublon.
    await run('questions/generate');
    const all = await questionsList();
    expect(all.length).toBeGreaterThan(ranked.length);
    expect(new Set(all.map((q) => q.text)).size).toBe(all.length);
    expect(all.filter((q) => q.status === 'open').map((q) => q.rank)).toEqual(
      all.map((_, i) => i + 1),
    );
    expect(all[0]?.id).toBe(first.id);
  });

  it('2. une réponse crée une source `answer` et des éléments `extracted` qui la citent ; la complétude augmente', async () => {
    const before = await head();
    const completenessBefore = completeness(before.model);
    const res = await consultantA.call('POST', `${base}/questions/${first.id}/answer`, {
      text: PILOT_ANSWER_ENVIRONMENT,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const answer = res.body as AnswerQuestionResult;
    expect(answer.source).toMatchObject({ kind: 'answer', textStatus: 'extracted' });
    expect(answer.question).toMatchObject({
      status: 'answered',
      answerSourceId: answer.source.id,
      answeredBy: SEED_IDS.consultantA,
    });
    const done = await waitRun(answer.runId);
    expect(done, JSON.stringify(done)).toMatchObject({ kind: 'answer', status: 'succeeded' });
    expect(done.resultVersion).toBe(before.version + 1);

    const after = await head();
    const trait = list(after.model).find(
      (e): e is BusinessTrait => e.kind === 'business_trait' && e.facet === 'environment',
    ) as BusinessTrait;
    expect(trait.status.value).toBe('extracted');
    expect(trait.provenance).toMatchObject({ origin: 'answer', author: { type: 'ai' } });
    expect(trait.provenance.refs).toHaveLength(1);
    const ref = trait.provenance.refs[0]!;
    expect(ref.sourceId).toBe(answer.source.id);
    const chunks = (await consultantA.call('GET', `${base}/sources/${answer.source.id}/chunks`))
      .body as ChunkDto[];
    expect(chunks.find((c) => c.id === ref.chunkId)?.text.slice(ref.locator.charStart, ref.locator.charEnd)).toBe(
      ref.quote,
    );
    const version = await admin.query(
      'select cause, ai_call_id from model_versions where mission_id = $1 and version = $2',
      [MISSION, after.version],
    );
    expect(version.rows[0]).toMatchObject({ cause: 'answer' });
    expect(version.rows[0]?.ai_call_id).not.toBeNull();
    expect(completeness(after.model).business.score).toBeGreaterThan(
      completenessBefore.business.score,
    );
    expect(parseModel(after.model).ok).toBe(true);

    // La question n'est plus ouverte ; une seconde réponse est refusée.
    const again = await consultantB.call('POST', `${base}/questions/${first.id}/answer`, {
      text: 'Autre réponse',
    });
    expect(again.status).toBe(409);
    expect(again.body.details?.reason).toBe('QUESTION_NOT_OPEN');
    const open = (await questionsList()).filter((q) => q.status === 'open');
    expect(open[0]?.rank).toBe(1);
    expect(open.some((q) => q.id === first.id)).toBe(false);
  });

  it('5. la complétude des activités augmente après une réponse qui apporte des tâches', async () => {
    const before = await head();
    const saisie = (await questionsList()).find((q) => q.text.includes('« Saisie »')) as QuestionDto;
    const res = await consultantA.call('POST', `${base}/questions/${saisie.id}/answer`, {
      text: PILOT_ANSWER_SAISIE,
    });
    expect(res.status).toBe(201);
    expect((await waitRun(res.body.runId)).status).toBe('succeeded');
    const after = await head();
    const tasks = list(after.model).filter(
      (e): e is Activity => e.kind === 'activity' && e.level === 'task',
    );
    expect(tasks.map((t) => t.label).sort()).toEqual([
      'Contrôle de cohérence',
      'Réception des pièces',
      'Saisie des écritures',
    ]);
    const parent = byLabel(after.model, 'Saisie') as Activity;
    expect(tasks.every((t) => t.parentId === parent.id && t.status.value === 'extracted')).toBe(true);
    expect(tasks.every((t) => t.provenance.origin === 'answer')).toBe(true);
    expect(completeness(after.model).activities.score).toBeGreaterThan(
      completeness(before.model).activities.score,
    );
  });

  it('une réponse sans élément exploitable ne crée aucune version', async () => {
    const before = await head();
    const rules = (await questionsList()).find((q) => q.concept === 'rules') as QuestionDto;
    const res = await consultantA.call('POST', `${base}/questions/${rules.id}/answer`, {
      text: 'Nous en parlerons lors du prochain atelier.',
    });
    expect(res.status).toBe(201);
    const done = await waitRun(res.body.runId);
    expect(done.status).toBe('succeeded');
    expect((await head()).version).toBe(before.version);
  });

  it('passer et arrêter le questionnement ne posent plus de question ; la liste reste lisible', async () => {
    const open = (await questionsList()).filter((q) => q.status === 'open');
    const skipped = await consultantA.call('POST', `${base}/questions/${open[0]!.id}/skip`, {});
    expect(skipped.status).toBe(201);
    expect(skipped.body).toMatchObject({ status: 'skipped', rank: null });
    expect((await consultantA.call('POST', `${base}/questions/${open[0]!.id}/skip`, {})).status).toBe(
      409,
    );
    const stopped = await consultantA.call('POST', `${base}/questions/stop`, {});
    expect(stopped.body.skipped).toBe(open.length - 1);
    const all = await questionsList();
    expect(all.some((q) => q.status === 'open')).toBe(false);
    // Une question passée n'est pas reposée par un nouveau lancement de `questions`.
    await run('questions/generate');
    const texts = (await questionsList()).map((q) => q.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  let hypotheses: Element[];

  it('hypothèses : origine ai_knowledge, justification, aucune citation, jamais confirmées', async () => {
    const before = await head();
    const done = await run('hypotheses/generate');
    expect(done.kind).toBe('hypotheses');
    const { model, version } = await head();
    expect(version).toBe(before.version + 1);
    hypotheses = list(model).filter((e) => e.status.value === 'hypothesis');
    expect(hypotheses.map((h) => h.label).sort()).toEqual(
      PILOT_HYPOTHESES.map((h) => h.proposal.label).sort(),
    );
    for (const h of hypotheses) {
      expect(h.provenance).toMatchObject({ origin: 'ai_knowledge', author: { type: 'ai' }, refs: [] });
      expect(h.provenance.rationale).toBeTruthy();
      expect(h.provenance.aiCallId).toBeTruthy();
    }
    expect(list(model).some((e) => e.status.value === 'confirmed')).toBe(false);
    const cause = await admin.query(
      'select cause from model_versions where mission_id = $1 and version = $2',
      [MISSION, version],
    );
    expect(cause.rows[0]?.cause).toBe('hypotheses');
    // Relancer ne duplique pas les hypothèses en attente.
    await run('hypotheses/generate');
    expect((await head()).version).toBe(version);
  });

  it('3. accepter une hypothèse la confirme (decidedBy) ; la corriger garde la valeur précédente', async () => {
    const term = hypotheses.find((h) => h.kind === 'glossary_term') as Element;
    const accepted = await decide(consultantA, term.id, { decision: 'accept' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body).toMatchObject({ outcome: 'confirmed' });
    const confirmed = (await head()).model.elements[term.id] as Element;
    expect(confirmed.status).toMatchObject({
      value: 'confirmed',
      decidedBy: SEED_IDS.consultantA,
    });
    expect(confirmed.provenance.origin).toBe('ai_knowledge');

    const trait = hypotheses.find((h) => h.kind === 'business_trait') as BusinessTrait;
    const corrected = await decide(consultantA, trait.id, {
      decision: 'correct',
      correction: {
        description: 'Observé sur les trois dernières années',
        text: 'Pic de charge en mars, avril et mai',
      },
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    const after = (await head()).model.elements[trait.id] as BusinessTrait;
    expect(after).toMatchObject({
      description: 'Observé sur les trois dernières années',
      text: 'Pic de charge en mars, avril et mai',
      status: { value: 'confirmed', decidedBy: SEED_IDS.consultantA },
    });
    expect(after.status.correction?.previous).toEqual({
      description: null,
      text: trait.text,
    });
    // Un attribut qui ne se corrige pas par formulaire est refusé.
    const actor = hypotheses.find((h) => h.kind === 'actor') as Element;
    expect(
      (await decide(consultantA, actor.id, { decision: 'correct', correction: { text: 'x' } })).status,
    ).toBe(400);
  });

  it('3. rejeter une hypothèse la retire du modèle, l’archive ; relancer `hypotheses` ne la repropose pas', async () => {
    const tool = hypotheses.find((h) => h.kind === 'tool') as Element;
    const rejected = await decide(consultantA, tool.id, { decision: 'reject', reason: 'Pas de GED' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(201);
    expect(rejected.body).toMatchObject({ outcome: 'rejected' });
    const { model, version } = await head();
    expect(model.elements[tool.id]).toBeUndefined();
    expect(model.rejectedHypotheses).toHaveLength(1);
    expect(model.rejectedHypotheses[0]).toMatchObject({
      by: SEED_IDS.consultantA,
      reason: 'Pas de GED',
      element: { id: tool.id, label: tool.label },
    });
    await run('hypotheses/generate');
    const again = await head();
    expect(again.version).toBe(version);
    expect(byLabel(again.model, tool.label)).toBeUndefined();
    // Même si le fournisseur s'obstine, le contrôle sémantique refuse la répétition et le code
    // n'écrit jamais l'hypothèse rejetée : l'exécution échoue, le modèle reste inchangé.
    registry.registerFakeScenario('hypotheses', () => ({
      proposals: [
        {
          ref: 'h1',
          kind: 'tool',
          label: tool.label,
          rationale: 'Toujours plausible',
          tool: { nature: 'software' },
        },
      ],
    }));
    const stubborn = await consultantA.call('POST', `${base}/hypotheses/generate`, {});
    expect((await waitRun(stubborn.body.runId)).status).toBe('failed');
    expect((await head()).version).toBe(version);
    const notification = await admin.query(
      `select payload from notifications where mission_id = $1 and kind = 'analysis.failed' order by created_at desc limit 1`,
      [MISSION],
    );
    expect(notification.rows[0]?.payload).toMatchObject({ kind: 'hypotheses' });
  });

  it('4. décisions concurrentes de deux consultants : le second reçoit « déjà décidé »', async () => {
    const actor = hypotheses.find((h) => h.kind === 'actor') as Element;
    const [a, b] = await Promise.all([
      decide(consultantA, actor.id, { decision: 'accept' }),
      decide(consultantB, actor.id, { decision: 'reject' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, JSON.stringify([a.body, b.body])).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe('CONFLICT');
    expect(loser.body.details?.reason).toBe('ALREADY_DECIDED');
    // Une nouvelle décision après coup est aussi « déjà décidée », qu'elle ait gagné ou perdu.
    const late = await decide(consultantB, actor.id, { decision: 'accept' });
    expect(late.status).toBe(409);
    expect(late.body.details?.reason).toBe('ALREADY_DECIDED');
  });

  it('confirmer un élément `extracted` (« Confirmer ») ; un élément extrait ne se rejette pas', async () => {
    const { model } = await head();
    const macro = list(model).find(
      (e): e is Activity => e.kind === 'activity' && e.level === 'macro' && e.code === 'P01',
    ) as Activity;
    expect(macro.status.value).toBe('extracted');
    expect((await decide(consultantA, macro.id, { decision: 'reject' })).status).toBe(400);
    const res = await decide(consultantB, macro.id, { decision: 'accept' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as DecisionResult).outcome).toBe('confirmed');
    expect((await head()).model.elements[macro.id]?.status).toMatchObject({
      value: 'confirmed',
      decidedBy: SEED_IDS.consultantB,
    });
    expect((await decide(consultantA, '00000000-0000-7000-8000-00000000ffff', { decision: 'accept' })).status).toBe(
      404,
    );
  });

  it('synthèse du métier : hypothèse à confirmer, jamais écrasée une fois décidée', async () => {
    await run('summary/generate');
    const { model } = await head();
    const summary = list(model).find(
      (e): e is BusinessTrait => e.kind === 'business_trait' && e.facet === 'summary',
    ) as BusinessTrait;
    expect(summary.status.value).toBe('hypothesis');
    expect(summary.provenance).toMatchObject({ origin: 'ai_knowledge' });
    expect(summary.text.length).toBeGreaterThan(20);
    await decide(consultantA, summary.id, { decision: 'accept' });
    const decided = await head();
    await run('summary/generate');
    expect((await head()).version).toBe(decided.version);
    expect((await head()).model.elements[summary.id]?.status.value).toBe('confirmed');
  });

  it('une seule exécution de chaque genre à la fois ; un échec du fournisseur est signalé sans écriture', async () => {
    registry.registerFakeScenario('questions', () => FakeSimulation.refusal() as never);
    const before = await head();
    const failing = await consultantA.call('POST', `${base}/questions/generate`, {});
    expect(failing.status).toBe(201);
    const second = await consultantA.call('POST', `${base}/questions/generate`, {});
    expect([201, 409]).toContain(second.status);
    if (second.status === 409) expect(second.body.details?.reason).toBe('GUIDED_IN_PROGRESS');
    expect((await waitRun(failing.body.runId)).status).toBe('failed');
    expect((await head()).version).toBe(before.version);
    registry.registerFakeScenario('questions', (() => ({ questions: [] })) as FakeScenario);
  });
});
