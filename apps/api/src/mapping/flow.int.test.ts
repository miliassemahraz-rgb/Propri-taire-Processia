import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type FakeScenario } from '@processia/ai';
import { loadEnv } from '@processia/config/env';
import type {
  DecisionResult,
  FlowDecisionResult,
  FlowOverviewDto,
  RunDto,
  StartFlowResult,
  SubmissionDto,
} from '@processia/contracts';
import { resetTestDatabase, resolveDbUrls, SEED_IDS, seedDevelopment } from '@processia/db';
import { checkCoherence, type Activity, type BusinessModel, type Element } from '@processia/model';
import {
  PILOT_DESCRIPTION,
  PILOT_FLOW_SCENARIOS,
  PILOT_RELANCE_PROCESS,
  PILOT_RELANCE_TASK,
  type ScenarioRequest,
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

// Intégration WP-17 : exige `pnpm services:up` (PostgreSQL, MinIO, Mailpit) et un Chromium pour
// les exports joints à la soumission (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH). Application Nest
// réelle sur HTTP, worker pg-boss dans le même processus, fournisseur IA factice (pilote).

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const base = `/missions/${MISSION}`;
const STRUCTURE = ['DEAD_END_BRANCH', 'UNREACHABLE_NODE', 'PROCESS_WITHOUT_START_OR_END'];

let app: INestApplication;
let baseUrl: string;
let admin: pg.Pool;
let consultantA: TestClient;
let manager: TestClient;
let rejectedIds: string[] = [];
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
  manager = await client().signIn('responsable@processia.local');
  consultantA = await client().signIn('consultante1@processia.local');
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

async function waitRun(runId: string, samples?: number[]): Promise<RunDto> {
  for (let i = 0; i < 1200; i += 1) {
    const res = await consultantA.call('GET', `${base}/runs/${runId}`);
    const run = res.body as RunDto;
    if (res.status === 200) samples?.push(run.progress);
    if (res.status === 200 && (run.status === 'succeeded' || run.status === 'failed')) return run;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Exécution non terminée.');
}

async function head(): Promise<{ version: number; model: BusinessModel }> {
  const res = await consultantA.call('GET', `${base}/model`);
  expect(res.status).toBe(200);
  return res.body as { version: number; model: BusinessModel };
}

const list = (m: BusinessModel): Element[] => Object.values(m.elements);
const activity = (m: BusinessModel, label: string): Activity =>
  list(m).find((e): e is Activity => e.kind === 'activity' && e.label === label) as Activity;

async function overview(who: TestClient = consultantA): Promise<FlowOverviewDto> {
  const res = await who.call('GET', `${base}/mapping/processes`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as FlowOverviewDto;
}

async function startFlows(body: unknown = {}): Promise<StartFlowResult> {
  const res = await consultantA.call('POST', `${base}/mapping/flows`, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as StartFlowResult;
}

describe('WP-17 : enchaînements des processus, niveaux 2 et 3', () => {
  it('prépare le pilote : analyse de la description', async () => {
    await setDescription(PILOT_DESCRIPTION);
    const res = await consultantA.call('POST', `${base}/analysis/extractions`, {});
    expect(res.status).toBe(201);
    expect((await waitRun(res.body.runId)).status).toBe('succeeded');
    const { model } = await head();
    expect(list(model).filter((e) => e.kind === 'activity' && e.level === 'process')).toHaveLength(
      45,
    );
  });

  it('avant la validation du dossier, toutes les routes de cartographie renvoient 409 PHASE_LOCKED', async () => {
    const calls: [string, string, unknown?][] = [
      ['GET', `${base}/mapping/processes`],
      ['POST', `${base}/mapping/flows`, {}],
      ['POST', `${base}/mapping/processes/${SEED_IDS.mission}/decision`, { decision: 'accept' }],
    ];
    for (const who of [consultantA, manager]) {
      for (const [method, path, body] of calls) {
        const res = await who.call(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(409);
        expect(res.body.code).toBe('PHASE_LOCKED');
      }
    }
  });

  it('le validateur (seul compte client) ne peut appeler aucune route de cartographie (403)', async () => {
    for (const [method, path, body] of [
      ['GET', `${base}/mapping/processes`],
      ['POST', `${base}/mapping/flows`, {}],
      ['POST', `${base}/mapping/processes/${SEED_IDS.mission}/decision`, { decision: 'accept' }],
    ] as [string, string, unknown?][]) {
      const res = await validator.call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('soumission et validation du dossier : la phase passe à « cartographie »', async () => {
    const submitted = await consultantA.call('POST', `${base}/submissions`, {
      kind: 'analysis_dossier',
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const id = (submitted.body as SubmissionDto).id;
    const validated = await validator.call('POST', `${base}/submissions/${id}/validate`, {});
    expect(validated.status, JSON.stringify(validated.body)).toBe(200);
    const gate = await consultantA.call('GET', `${base}/mapping`);
    expect(gate.status).toBe(200);
  });

  it('état initial : 45 processus, aucun enchaînement', async () => {
    const state = await overview();
    expect(state.processes).toHaveLength(45);
    expect(state.processes.every((p) => !p.flowBuilt && p.nodeCount === 0)).toBe(true);
    expect(state.lastRun).toBeNull();
    const codes = state.processes.map((p) => p.code);
    expect(codes.slice(0, 3)).toEqual(['P01.1', 'P01.2', 'P01.3']);
  });

  it('une demande invalide est refusée (400) ; un lot sans cible aussi (409)', async () => {
    const both = await consultantA.call('POST', `${base}/mapping/flows`, {
      processIds: [SEED_IDS.mission],
      detailTaskIds: [SEED_IDS.mission],
    });
    expect(both.status).toBe(400);
    const notAProcess = await consultantA.call('POST', `${base}/mapping/flows`, {
      processIds: [SEED_IDS.mission],
    });
    expect(notAProcess.status).toBe(400);
    const notATask = await consultantA.call('POST', `${base}/mapping/flows`, {
      detailTaskIds: [SEED_IDS.mission],
    });
    expect(notATask.status).toBe(400);
  });

  it('deux lancements simultanés : un seul lot à la fois (409 FLOW_IN_PROGRESS)', async () => {
    const { processes } = await overview();
    const ids = processes.slice(0, 2).map((p) => p.id);
    const [a, b] = await Promise.all([
      consultantA.call('POST', `${base}/mapping/flows`, { processIds: ids }),
      manager.call('POST', `${base}/mapping/flows`, { processIds: ids }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.details).toMatchObject({ reason: 'FLOW_IN_PROGRESS' });
    const winner = (a.status === 201 ? a : b).body as StartFlowResult;
    expect(await waitRun(winner.runId)).toMatchObject({ status: 'succeeded' });
    const after = await overview();
    expect(after.processes.filter((p) => p.flowBuilt).map((p) => p.code)).toEqual([
      'P01.1',
      'P01.2',
    ]);
  });

  it('critère 1 : le job traite tous les processus, avec progression ; chacun a un début, une fin, sans impasse', async () => {
    const started = await startFlows();
    const samples: number[] = [];
    const run = await waitRun(started.runId, samples);
    expect(run).toMatchObject({ status: 'succeeded', progress: 100, error: null });
    expect(run.resultVersion).toBeGreaterThan(0);
    expect(samples.some((s) => s > 0 && s < 100)).toBe(true);
    expect(samples).toEqual([...samples].sort((x, y) => x - y));

    const { model } = await head();
    const state = await overview();
    expect(state.lastRun).toMatchObject({ status: 'succeeded', progress: 100, failures: [] });
    expect(state.processes.every((p) => p.flowBuilt)).toBe(true);
    const events = list(model).filter((e) => e.kind === 'event');
    for (const p of state.processes) {
      const own = events.filter((e) => e.kind === 'event' && e.containerId === p.id);
      expect(
        own.some((e) => e.kind === 'event' && e.position === 'start'),
        `${p.code} : début`,
      ).toBe(true);
      expect(
        own.some((e) => e.kind === 'event' && e.position === 'end'),
        `${p.code} : fin`,
      ).toBe(true);
    }
    expect(checkCoherence(model).filter((i) => STRUCTURE.includes(i.code))).toEqual([]);
    // Un lot de plus n'a plus rien à construire.
    const again = await consultantA.call('POST', `${base}/mapping/flows`, {});
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'NOTHING_TO_BUILD' });
  });

  it('critère 2 : les nouveaux éléments sont des hypothèses avec une justification (aucun élément existant modifié)', async () => {
    const { model } = await head();
    const created = list(model).filter((e) =>
      ['event', 'gateway', 'sequence_flow', 'rule'].includes(e.kind),
    );
    expect(created.length).toBeGreaterThan(200);
    const tasks = list(model).filter((e) => e.kind === 'activity' && e.level === 'task');
    expect(tasks.length).toBeGreaterThan(40);
    for (const e of [...created, ...tasks]) {
      expect(e.status.value, e.code).toBe('hypothesis');
      expect(e.provenance.rationale, e.code).toBeTruthy();
      expect(e.provenance.origin).toBe('ai_knowledge');
      expect(e.provenance.author.type).toBe('ai');
      expect(e.provenance.aiCallId, e.code).toBeTruthy();
    }
    // Les 14 macroprocessus et les 45 processus extraits n'ont pas été touchés.
    const extracted = list(model).filter(
      (e) => e.kind === 'activity' && (e.level === 'macro' || e.level === 'process'),
    );
    expect(extracted.every((e) => e.status.value === 'validated')).toBe(true);
    const versions = await consultantA.call('GET', `${base}/model/versions`);
    const flowVersions = (versions.body as { cause: string }[]).filter(
      (v) => v.cause === 'process_flow',
    );
    expect(flowVersions).toHaveLength(45);
  });

  it('un processus proposé sans tâche reçoit des tâches de l’IA, avec un responsable', async () => {
    const { model } = await head();
    const relances = activity(model, PILOT_RELANCE_PROCESS);
    const tasks = list(model).filter(
      (e): e is Activity =>
        e.kind === 'activity' && e.level === 'task' && e.parentId === relances.id,
    );
    expect(tasks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((t) => t.label)).toEqual([
      'Identifier les pièces manquantes',
      PILOT_RELANCE_TASK,
      'Réceptionner et classer les pièces',
    ]);
    expect(tasks.every((t) => t.responsibleActorId !== undefined)).toBe(true);
    const gateways = list(model).filter(
      (e) => e.kind === 'gateway' && e.containerId === relances.id,
    );
    expect(gateways).toHaveLength(1);
    expect(gateways[0]?.kind === 'gateway' && gateways[0].ruleId).toBeTruthy();
  });

  it('critère 3 : P04 « Relance des pièces manquantes » a un niveau 3 (champs, délais, destinataires, indicateurs, règles)', async () => {
    const before = await head();
    const task = activity(before.model, PILOT_RELANCE_TASK);
    const state = await overview();
    const entry = state.processes.flatMap((p) => p.tasks).find((t) => t.id === task.id);
    expect(entry).toMatchObject({ detailed: false });
    const started = await startFlows({ detailTaskIds: [task.id] });
    expect(await waitRun(started.runId)).toMatchObject({ status: 'succeeded' });
    const { model } = await head();
    const steps = list(model).filter(
      (e): e is Activity => e.kind === 'activity' && e.level === 'step' && e.parentId === task.id,
    );
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(steps.every((s) => s.code.startsWith(`${task.code}.`))).toBe(true);
    const own = list(model).filter((e) => !(e.id in before.model.elements));
    const form = own.find((e) => e.kind === 'data_object');
    expect(form?.kind === 'data_object' && form.fields.map((f) => f.name)).toEqual([
      'Destinataire',
      'Pièces manquantes',
      'Date limite de réponse',
      'Canal d’envoi',
      'Numéro de la relance',
    ]);
    expect(
      form?.kind === 'data_object' && form.fields.every((f) => f.status.value === 'hypothesis'),
    ).toBe(true);
    const delay = own.find((e) => e.kind === 'indicator' && e.measure === 'lead_time');
    expect(delay?.kind === 'indicator' && [delay.value.exact, delay.unit, delay.targetId]).toEqual([
      7,
      'jours',
      task.id,
    ]);
    expect(own.some((e) => e.kind === 'rule' && e.type === 'exception')).toBe(true);
    expect(own.some((e) => e.kind === 'rule' && e.type === 'decision')).toBe(true);
    expect(
      own.some(
        (e) => e.kind === 'event' && e.trigger === 'timer' && e.timer === 'J+7 après l’envoi',
      ),
    ).toBe(true);
    const client = list(model).find((e) => e.label === 'Client du cabinet');
    expect(
      own.some(
        (e) => e.kind === 'information_flow' && e.toActorId === client?.id && e.channel === 'email',
      ),
    ).toBe(true);
    for (const e of own) {
      expect(e.status.value, e.code).toBe('hypothesis');
      expect(e.provenance.rationale, e.code).toBeTruthy();
    }
    expect(checkCoherence(model).filter((i) => STRUCTURE.includes(i.code))).toEqual([]);
    // Détailler une seconde fois la même tâche ne produit rien de plus.
    const again = await consultantA.call('POST', `${base}/mapping/flows`, {
      detailTaskIds: [task.id],
    });
    expect(again.status).toBe(409);
    const after = await overview();
    expect(after.processes.flatMap((p) => p.tasks).find((t) => t.id === task.id)).toMatchObject({
      detailed: true,
    });
  });

  it('revue des hypothèses (WP-14) : rejeter un nœud rejette en cascade les flux qui en dépendent', async () => {
    const { model } = await head();
    const process = activity(model, 'Saisie');
    const start = list(model).find(
      (e) => e.kind === 'event' && e.containerId === process.id && e.position === 'start',
    ) as Element;
    const flowsFromStart = list(model).filter(
      (e) => e.kind === 'sequence_flow' && (e.fromId === start.id || e.toId === start.id),
    );
    expect(flowsFromStart.length).toBeGreaterThan(0);
    const res = await consultantA.call('POST', `${base}/elements/${start.id}/decision`, {
      decision: 'reject',
      reason: 'Le processus démarre autrement',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as DecisionResult).outcome).toBe('rejected');
    const after = (await head()).model;
    expect(after.elements[start.id]).toBeUndefined();
    for (const f of flowsFromStart) expect(after.elements[f.id]).toBeUndefined();
    const archived = after.rejectedHypotheses.map((r) => r.element.id);
    expect(archived).toContain(start.id);
    for (const f of flowsFromStart) expect(archived).toContain(f.id);
  });

  it('accepter un objet de données confirme aussi ses champs', async () => {
    const { model } = await head();
    const form = list(model).find((e) => e.kind === 'data_object') as Element;
    const res = await consultantA.call('POST', `${base}/elements/${form.id}/decision`, {
      decision: 'accept',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const after = (await head()).model.elements[form.id];
    expect(after?.status.value).toBe('confirmed');
    expect(
      after?.kind === 'data_object' && after.fields.every((f) => f.status.value === 'confirmed'),
    ).toBe(true);
  });

  it('décision groupée : confirmer ou écarter l’enchaînement d’un processus', async () => {
    const state = await overview();
    const [a, b, c] = state.processes.filter((p) => p.label !== 'Saisie' && p.pendingCount > 0);
    expect(a && b && c).toBeTruthy();
    const accepted = await consultantA.call('POST', `${base}/mapping/processes/${a?.id}/decision`, {
      decision: 'accept',
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect((accepted.body as FlowDecisionResult).outcome).toBe('confirmed');
    expect((accepted.body as FlowDecisionResult).count).toBeGreaterThan(5);
    let { model } = await head();
    const left = (await overview()).processes.find((p) => p.id === a?.id);
    expect(left?.pendingCount).toBe(0);
    expect(
      list(model)
        .filter((e) => e.kind === 'event' && e.containerId === a?.id)
        .every((e) => e.status.value === 'confirmed'),
    ).toBe(true);
    const again = await consultantA.call('POST', `${base}/mapping/processes/${a?.id}/decision`, {
      decision: 'accept',
    });
    expect(again.status).toBe(409);

    const rejected = await consultantA.call('POST', `${base}/mapping/processes/${b?.id}/decision`, {
      decision: 'reject',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(201);
    model = (await head()).model;
    expect(list(model).some((e) => e.kind === 'event' && e.containerId === b?.id)).toBe(false);
    const rebuilt = (await overview()).processes.find((p) => p.id === b?.id);
    expect(rebuilt).toMatchObject({ flowBuilt: false, nodeCount: 0 });
    const rejectedC = await consultantA.call(
      'POST',
      `${base}/mapping/processes/${c?.id}/decision`,
      {
        decision: 'reject',
      },
    );
    expect(rejectedC.status, JSON.stringify(rejectedC.body)).toBe(201);
    rejectedIds = [b?.id as string, c?.id as string];
  });

  it('un processus en échec est rapporté sans bloquer les autres ; l’enchaînement écarté se reconstruit', async () => {
    const registry = app.get(AiProviderRegistry);
    const state = await overview();
    const [failing, other] = rejectedIds.map(
      (id) => state.processes.find((p) => p.id === id) as FlowOverviewDto['processes'][number],
    );
    expect(failing && other).toBeTruthy();
    expect(failing?.flowBuilt).toBe(false);
    const pilot = PILOT_FLOW_SCENARIOS['process.flow'] as (req: ScenarioRequest) => unknown;
    // Le fournisseur propose, pour un seul processus, un enchaînement sans fin : il est refusé.
    registry.registerFakeScenario('process.flow', ((req: ScenarioRequest) => {
      const content = req.messages.find((m) => m.role === 'user')?.content ?? '';
      if (content.includes(`"code":"${failing?.code}"`)) {
        const out = pilot(req) as { nodes: { kind: string; position?: string }[] };
        return { ...out, nodes: out.nodes.filter((n) => n.position !== 'end') };
      }
      return pilot(req);
    }) as FakeScenario);
    try {
      const started = await startFlows({ processIds: rejectedIds });
      const run = await waitRun(started.runId);
      expect(run.status).toBe('succeeded');
      const last = (await overview()).lastRun;
      expect(last?.failures).toHaveLength(1);
      expect(last?.failures[0]?.code).toBe(failing?.code);
      const after = (await overview()).processes;
      expect(after.find((p) => p.id === failing?.id)?.flowBuilt).toBe(false);
      expect(after.find((p) => p.id === other?.id)?.flowBuilt).toBe(true);
      const { model } = await head();
      // Seul « Saisie » (dont le consultant a rejeté le début) reste sans début, et lui seul.
      const structural = checkCoherence(model).filter((i) => STRUCTURE.includes(i.code));
      expect(structural.map((i) => model.elements[i.elementId]?.label)).toEqual(['Saisie']);
    } finally {
      registry.registerFakeScenario('process.flow', pilot as FakeScenario);
    }
    const retry = await startFlows({ processIds: [failing?.id] });
    expect(await waitRun(retry.runId)).toMatchObject({ status: 'succeeded', error: null });
    expect((await overview()).processes.find((p) => p.id === failing?.id)?.flowBuilt).toBe(true);
  });
});
