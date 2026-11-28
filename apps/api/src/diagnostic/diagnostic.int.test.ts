import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@processia/config/env';
import type {
  DecisionResult,
  DiagnosticOverviewDto,
  FlowOverviewDto,
  RunDto,
  StartDiagnosticResult,
  SubmissionDto,
  SubmissionMappingDto,
  ValidateSubmissionResult,
} from '@processia/contracts';
import { resetTestDatabase, resolveDbUrls, SEED_IDS, seedDevelopment } from '@processia/db';
import {
  FINDING_FAMILIES,
  diagramOfElement,
  buildOutline,
  type Activity,
  type BusinessModel,
  type Element,
  type Finding,
} from '@processia/model';
import { PILOT_DESCRIPTION, PILOT_RELANCE_TASK } from '@processia/test-fixtures';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { RATE_LIMIT_OPTIONS } from '../auth/guards.js';
import { ENV } from '../env.js';
import { JobsService } from '../jobs/jobs.service.js';
import { TestClient } from '../testing/http-client.js';

// Intégration WP-21 : exige `pnpm services:up` (PostgreSQL, MinIO, Mailpit) et un Chromium pour les
// exports joints aux soumissions (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH). Application Nest réelle sur
// HTTP, worker pg-boss dans le même processus, fournisseur IA factice (pilote).

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const base = `/missions/${MISSION}`;

let app: INestApplication;
let baseUrl: string;
let admin: pg.Pool;
let consultantA: TestClient;
let manager: TestClient;
let validator: TestClient;
let asIsSubmissionId = '';
let dossierSubmissionId = '';
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
  for (let i = 0; i < 1500; i += 1) {
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
const findingsOf = (m: BusinessModel): Finding[] =>
  list(m).filter((e): e is Finding => e.kind === 'finding');

async function diagnosticOverview(who: TestClient = consultantA): Promise<DiagnosticOverviewDto> {
  const res = await who.call('GET', `${base}/diagnostic`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as DiagnosticOverviewDto;
}

async function runDiagnostic(): Promise<RunDto> {
  const started = await consultantA.call('POST', `${base}/diagnostic/runs`, {});
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return waitRun((started.body as StartDiagnosticResult).runId);
}

describe('WP-21 : validation de l’AS-IS et diagnostic', () => {
  it('prépare le pilote : analyse, dossier validé, enchaînements construits puis confirmés', async () => {
    await setDescription(PILOT_DESCRIPTION);
    const analysed = await consultantA.call('POST', `${base}/analysis/extractions`, {});
    expect(analysed.status).toBe(201);
    expect((await waitRun(analysed.body.runId)).status).toBe('succeeded');

    const dossier = await consultantA.call('POST', `${base}/submissions`, {
      kind: 'analysis_dossier',
    });
    expect(dossier.status, JSON.stringify(dossier.body)).toBe(201);
    dossierSubmissionId = (dossier.body as SubmissionDto).id;
    const ok = await validator.call(
      'POST',
      `${base}/submissions/${dossierSubmissionId}/validate`,
      {},
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const flows = await consultantA.call('POST', `${base}/mapping/flows`, {});
    expect(flows.status, JSON.stringify(flows.body)).toBe(201);
    expect((await waitRun(flows.body.runId)).status).toBe('succeeded');
    const before = await head();
    const relance = list(before.model).find(
      (e): e is Activity =>
        e.kind === 'activity' && e.level === 'task' && e.label === PILOT_RELANCE_TASK,
    ) as Activity;
    const detail = await consultantA.call('POST', `${base}/mapping/flows`, {
      detailTaskIds: [relance.id],
    });
    expect(detail.status, JSON.stringify(detail.body)).toBe(201);
    expect((await waitRun(detail.body.runId)).status).toBe('succeeded');

    // Le consultant relit et confirme les enchaînements de chaque processus, puis le niveau 3.
    const state = (await consultantA.call('GET', `${base}/mapping/processes`))
      .body as FlowOverviewDto;
    for (const process of state.processes) {
      const res = await consultantA.call(
        'POST',
        `${base}/mapping/processes/${process.id}/decision`,
        {
          decision: 'accept',
        },
      );
      expect([201, 409], JSON.stringify(res.body)).toContain(res.status);
    }
    const detailed = await consultantA.call(
      'POST',
      `${base}/mapping/processes/${relance.parentId}/decision`,
      { decision: 'accept', taskId: relance.id },
    );
    expect([201, 409]).toContain(detailed.status);
    const { model } = await head();
    expect(list(model).filter((e) => e.status.value === 'hypothesis')).toHaveLength(0);
  }, 240_000);

  it('critère 1 : avant la validation de l’AS-IS, le diagnostic répond 409 PHASE_LOCKED', async () => {
    for (const who of [consultantA, manager]) {
      const overview = await who.call('GET', `${base}/diagnostic`);
      expect(overview.status).toBe(409);
      expect(overview.body.code).toBe('PHASE_LOCKED');
      const start = await who.call('POST', `${base}/diagnostic/runs`, {});
      expect(start.status).toBe(409);
      expect(start.body.code).toBe('PHASE_LOCKED');
    }
  });

  it('le validateur ne peut ni lancer ni lire le diagnostic (403)', async () => {
    expect((await validator.call('GET', `${base}/diagnostic`)).status).toBe(403);
    expect((await validator.call('POST', `${base}/diagnostic/runs`, {})).status).toBe(403);
  });

  it('soumission de l’AS-IS : aperçu, hypothèses exclues, version figée', async () => {
    const preview = await consultantA.call('GET', `${base}/submissions/preview?kind=as_is`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.blocker).toBeNull();
    expect(preview.body.includedCount).toBeGreaterThan(100);
    const submitted = await consultantA.call('POST', `${base}/submissions`, { kind: 'as_is' });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const submission = submitted.body as SubmissionDto;
    expect(submission).toMatchObject({ kind: 'as_is', round: 1, status: 'submitted' });
    asIsSubmissionId = submission.id;
  });

  it('le validateur lit la cartographie de la version figée : sans hypothèse, sans constat, jamais la tête', async () => {
    // Le consultant modifie la tête après la soumission : le validateur ne le voit pas.
    const res = await validator.call('GET', `${base}/submissions/${asIsSubmissionId}/mapping`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const mapping = res.body as SubmissionMappingDto;
    const submission = (await validator.call('GET', `${base}/submissions/${asIsSubmissionId}`))
      .body as SubmissionDto;
    expect(mapping.version).toBe(submission.modelVersion);
    const frozen = list(mapping.model);
    expect(frozen.filter((e) => e.kind === 'activity' && e.level === 'process')).toHaveLength(45);
    expect(frozen.some((e) => e.kind === 'event')).toBe(true);
    expect(frozen.every((e) => e.status.value !== 'hypothesis')).toBe(true);
    expect(frozen.some((e) => ['finding', 'optimisation', 'discrepancy'].includes(e.kind))).toBe(
      false,
    );
    expect(Object.keys(mapping.model.layout)).toHaveLength(0);
    expect(buildOutline(mapping.model, 'L0')?.nodes.length).toBe(14);
    // Une soumission du dossier d'analyse n'a pas de cartographie.
    const dossier = await validator.call(
      'GET',
      `${base}/submissions/${dossierSubmissionId}/mapping`,
    );
    expect(dossier.status).toBe(404);
  });

  it('critère 1 : la soumission non validée ne suffit pas, le diagnostic reste verrouillé (409)', async () => {
    const res = await consultantA.call('GET', `${base}/diagnostic`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PHASE_LOCKED');
  });

  it('critère 1 : le validateur valide l’AS-IS, la mission passe en « transformation »', async () => {
    const res = await validator.call('POST', `${base}/submissions/${asIsSubmissionId}/validate`, {
      comment: 'AS-IS conforme à notre fonctionnement.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = res.body as ValidateSubmissionResult;
    expect(result.phase).toBe('transformation');
    expect(result.validatedCount).toBeGreaterThan(100);
    const { model } = await head();
    const processes = list(model).filter((e) => e.kind === 'activity' && e.level === 'process');
    expect(processes.every((p) => p.status.value === 'validated')).toBe(true);
    const mission = await consultantA.call('GET', base);
    expect(mission.body.phase).toBe('transformation');
    // Une seconde soumission de l'AS-IS est refusée : déjà validé.
    const again = await consultantA.call('POST', `${base}/submissions`, { kind: 'as_is' });
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'ALREADY_VALIDATED' });
  }, 60_000);

  it('le diagnostic est ouvert : périmètre, aucun constat, aucune exécution', async () => {
    const overview = await diagnosticOverview();
    expect(overview.macroCount).toBeGreaterThan(0);
    expect(overview.findingCount).toBe(0);
    expect(overview.lastRun).toBeNull();
  });

  it('un seul diagnostic à la fois (409 DIAGNOSTIC_IN_PROGRESS)', async () => {
    const [a, b] = await Promise.all([
      consultantA.call('POST', `${base}/diagnostic/runs`, {}),
      manager.call('POST', `${base}/diagnostic/runs`, {}),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.details).toMatchObject({ reason: 'DIAGNOSTIC_IN_PROGRESS' });
    const winner = (a.status === 201 ? a : b).body as StartDiagnosticResult;
    const samples: number[] = [];
    const run = await waitRun(winner.runId, samples);
    expect(run).toMatchObject({ status: 'succeeded', progress: 100, error: null });
    expect(run.resultVersion).toBeGreaterThan(0);
    expect(samples).toEqual([...samples].sort((x, y) => x - y));
  });

  it('critère 3 : au moins un constat par famille, chacun localisé sur un élément visible sur la carte', async () => {
    const { model } = await head();
    const findings = findingsOf(model);
    expect(findings.length).toBeGreaterThan(5);
    for (const family of FINDING_FAMILIES) {
      expect(
        findings.some((f) => f.family === family),
        family,
      ).toBe(true);
    }
    for (const finding of findings) {
      const visible = finding.location.filter((id) => {
        const diagram = diagramOfElement(model, id);
        return (
          diagram !== undefined &&
          buildOutline(model, diagram)?.nodes.some((n) => n.id === id) === true
        );
      });
      expect(visible.length, `${finding.code} ${finding.label}`).toBeGreaterThanOrEqual(1);
    }
    const overview = await diagnosticOverview();
    expect(overview.findingCount).toBe(findings.length);
    expect(overview.lastRun).toMatchObject({ status: 'succeeded', failures: [] });
  });

  it('critère 4 : constats de l’IA en hypothèse, constats des règles d’origine deterministic_rule', async () => {
    const { model } = await head();
    const findings = findingsOf(model);
    const byAi = findings.filter((f) => f.detection.by === 'ai');
    const byRule = findings.filter((f) => f.detection.by === 'rule');
    expect(byAi.length).toBeGreaterThan(0);
    expect(byRule.length).toBeGreaterThan(0);
    for (const f of byAi) {
      expect(f.status.value).toBe('hypothesis');
      expect(f.provenance).toMatchObject({ origin: 'ai_knowledge', author: { type: 'ai' } });
      expect(f.provenance.aiCallId, f.code).toBeTruthy();
      expect(f.provenance.rationale).toBeTruthy();
    }
    for (const f of byRule) {
      expect(f.provenance).toMatchObject({
        origin: 'deterministic_rule',
        author: { type: 'system' },
      });
      expect(f.detection.detectorId).toBeTruthy();
      expect(f.status.value).toBe('hypothesis');
    }
    const calls = await admin.query(
      `select count(*)::int as n from ai_calls where mission_id = $1 and pipeline = 'diagnostic'`,
      [MISSION],
    );
    expect(calls.rows[0].n).toBeGreaterThanOrEqual(14);
  });

  it('le diagnostic ne modifie que des constats : aucun autre élément n’a changé', async () => {
    const versions = await consultantA.call('GET', `${base}/model/versions`);
    const diag = (versions.body as { cause: string; version: number }[]).filter(
      (v) => v.cause === 'diagnostic',
    );
    expect(diag.length).toBeGreaterThanOrEqual(2);
    const first = diag.map((v) => v.version).sort((a, b) => a - b)[0] as number;
    const diff = await consultantA.call('GET', `${base}/model/diff?from=${first - 1}&to=${first}`);
    expect(diff.status).toBe(200);
    expect(diff.body.removed).toEqual([]);
    expect(diff.body.modified).toEqual([]);
  });

  it('relancer le diagnostic ne reproduit aucun constat', async () => {
    const before = findingsOf((await head()).model).length;
    const run = await runDiagnostic();
    expect(run.status).toBe('succeeded');
    expect(run.resultVersion).toBeNull();
    expect(findingsOf((await head()).model)).toHaveLength(before);
  });

  it('le consultant confirme un constat, en rejette un autre : le rejet n’est pas reproposé', async () => {
    const { model } = await head();
    const [keep, drop] = findingsOf(model) as [Finding, Finding];
    const accepted = await consultantA.call('POST', `${base}/elements/${keep.id}/decision`, {
      decision: 'accept',
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect((accepted.body as DecisionResult).outcome).toBe('confirmed');
    const rejected = await consultantA.call('POST', `${base}/elements/${drop.id}/decision`, {
      decision: 'reject',
      reason: 'Déjà connu du client.',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(201);

    const after = (await head()).model;
    expect(after.elements[keep.id]?.status.value).toBe('confirmed');
    expect(after.elements[drop.id]).toBeUndefined();
    expect(after.rejectedHypotheses.some((r) => r.element.id === drop.id)).toBe(true);
    const count = findingsOf(after).length;

    const run = await runDiagnostic();
    expect(run.status).toBe('succeeded');
    const rerun = (await head()).model;
    expect(findingsOf(rerun)).toHaveLength(count);
    expect(
      findingsOf(rerun).some(
        (f) => f.type === drop.type && f.location.join() === drop.location.join(),
      ),
    ).toBe(false);
  });
});
