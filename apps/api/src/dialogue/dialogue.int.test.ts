import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@processia/config/env';
import type {
  CommitResult,
  DialogueDto,
  FlowOverviewDto,
  ProposalDto,
  RunDto,
  SendDialogueResult,
  StartFlowResult,
  SubmissionDto,
  VersionSummary,
} from '@processia/contracts';
import { resetTestDatabase, resolveDbUrls, SEED_IDS, seedDevelopment } from '@processia/db';
import { buildOutline, type Activity, type BusinessModel, type Element } from '@processia/model';
import { PILOT_DESCRIPTION } from '@processia/test-fixtures';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { RATE_LIMIT_OPTIONS } from '../auth/guards.js';
import { ENV } from '../env.js';
import { JobsService } from '../jobs/jobs.service.js';
import { TestClient } from '../testing/http-client.js';

// Intégration WP-20 : exige `pnpm services:up` (PostgreSQL, MinIO, Mailpit) et un Chromium pour
// les exports joints à la soumission. Application Nest réelle sur HTTP, fournisseur IA factice.

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const base = `/missions/${MISSION}`;
const CONTROL = 'Contrôle des écritures';
const CONTROL_TASK = `${CONTROL} : réalisation`;
const INSERT = 'ajoute une validation par le chef de mission après la révision';

let app: INestApplication;
let baseUrl: string;
let admin: pg.Pool;
let consultantA: TestClient;
let consultantB: TestClient;
let validator: TestClient;
let outsider: TestClient;
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
  consultantA = await client().signIn('consultante1@processia.local');
  consultantB = await client().signIn('consultant2@processia.local');
  validator = await client().signIn('validateur@processia.local');
  outsider = await client().signIn('admin@processia.local');
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
  for (let i = 0; i < 1200; i += 1) {
    const res = await consultantA.call('GET', `${base}/runs/${runId}`);
    const run = res.body as RunDto;
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

async function versions(): Promise<VersionSummary[]> {
  const res = await consultantA.call('GET', `${base}/model/versions`);
  expect(res.status).toBe(200);
  return res.body as VersionSummary[];
}

const list = (m: BusinessModel): Element[] => Object.values(m.elements);
const activity = (m: BusinessModel, label: string): Activity =>
  list(m).find((e): e is Activity => e.kind === 'activity' && e.label === label) as Activity;

let processId = '';
const diagram = (): string => `L2:${processId}`;

async function say(
  who: TestClient,
  text: string,
  focus: { diagram: string; selectedId?: string } = { diagram: diagram() },
): Promise<SendDialogueResult> {
  const res = await who.call('POST', `${base}/dialogue/messages`, { text, focus });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as SendDialogueResult;
}

describe('WP-20 : modification par dialogue', () => {
  it('prépare le pilote : analyse, validation du dossier, enchaînements de trois processus', async () => {
    await setDescription(PILOT_DESCRIPTION);
    const analysis = await consultantA.call('POST', `${base}/analysis/extractions`, {});
    expect(analysis.status).toBe(201);
    expect((await waitRun(analysis.body.runId)).status).toBe('succeeded');

    // Avant la validation du dossier : les routes du dialogue sont verrouillées.
    for (const [method, path, body] of [
      ['GET', `${base}/dialogue`],
      ['POST', `${base}/dialogue/messages`, { text: INSERT }],
      ['POST', `${base}/dialogue/proposals/01900000-0000-7000-8000-000000000001/regenerate`, {}],
    ] as [string, string, unknown?][]) {
      const res = await consultantA.call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(res.body.code).toBe('PHASE_LOCKED');
    }

    const submitted = await consultantA.call('POST', `${base}/submissions`, {
      kind: 'analysis_dossier',
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const validated = await validator.call(
      'POST',
      `${base}/submissions/${(submitted.body as SubmissionDto).id}/validate`,
      {},
    );
    expect(validated.status, JSON.stringify(validated.body)).toBe(200);

    const overview = (await consultantA.call('GET', `${base}/mapping/processes`))
      .body as FlowOverviewDto;
    const ids = ['Contrôle des écritures', 'Traitement des anomalies', 'Relances clients'].map(
      (label) => overview.processes.find((p) => p.label === label)?.id as string,
    );
    processId = ids[0] as string;
    const started = await consultantA.call('POST', `${base}/mapping/flows`, { processIds: ids });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect((await waitRun((started.body as StartFlowResult).runId)).status).toBe('succeeded');
  }, 120_000);

  it('le validateur et un compte non affecté n’ont pas accès au dialogue', async () => {
    const calls: [string, string, unknown?][] = [
      ['GET', `${base}/dialogue`],
      ['POST', `${base}/dialogue/messages`, { text: INSERT }],
    ];
    for (const [method, path, body] of calls) {
      expect((await validator.call(method, path, body)).status, `validateur ${path}`).toBe(403);
      // L'administrateur peut lire mais jamais modifier la cartographie.
      if (method === 'POST') {
        expect((await outsider.call(method, path, body)).status, `admin ${path}`).toBe(403);
      }
    }
  });

  it('une consigne vide ou trop longue est refusée (400)', async () => {
    for (const text of ['', '   ', 'x'.repeat(1_501)]) {
      const res = await consultantA.call('POST', `${base}/dialogue/messages`, { text });
      expect(res.status).toBe(400);
    }
    const res = await consultantA.call('POST', `${base}/dialogue/messages`, {
      text: INSERT,
      focus: { diagram: 'n’importe quoi' },
    });
    expect(res.status).toBe(400);
  });

  it('critères 1 et 5 : l’aperçu montre la tâche et les enchaînements, rien n’est enregistré avant « Appliquer »', async () => {
    const before = await head();
    const versionsBefore = (await versions()).length;
    const result = await say(consultantA, INSERT);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const proposal = result.proposal as ProposalDto;
    expect(proposal.status).toBe('pending');
    expect(proposal.baseVersion).toBe(before.version);
    expect(result.messages[1]?.proposalId).toBe(proposal.id);
    expect(proposal.explanation).toMatch(/Chef de mission/);
    expect(proposal.diff?.added.length).toBeGreaterThanOrEqual(2);
    expect(proposal.diff?.modified.some((m) => m.fields.includes('toId'))).toBe(true);
    expect(proposal.warnings.some((w) => w.code === 'ACTIVITY_WITHOUT_OWNER')).toBe(false);

    // Aperçu : le modèle et l'historique n'ont pas bougé.
    const after = await head();
    expect(after.version).toBe(before.version);
    expect((await versions()).length).toBe(versionsBefore);
    expect(list(after.model).some((e) => e.label === 'Validation par le chef de mission')).toBe(
      false,
    );

    // « Appliquer » crée la version N+1 et le niveau 2 contient la tâche, dans le couloir.
    const applied = await consultantA.call('POST', `${base}/proposals/${proposal.id}/apply`);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const result2 = applied.body as { result: CommitResult; proposal: ProposalDto };
    expect(result2.result.version).toBe(before.version + 1);
    expect(result2.proposal.status).toBe('applied');
    const now = await head();
    expect(now.version).toBe(before.version + 1);
    const task = activity(now.model, 'Validation par le chef de mission');
    expect(task.status.value).toBe('confirmed');
    expect(task.provenance.origin).toBe('consultant');
    expect(now.model.elements[task.responsibleActorId as string]?.label).toBe('Chef de mission');
    const outline = buildOutline(now.model, diagram());
    const lane = outline?.groups.find((g) => g.nodeIds.includes(task.id));
    expect(lane?.label).toBe('Chef de mission');
    const latest = (await versions())[0];
    expect(latest).toMatchObject({ cause: 'dialogue_edit', version: before.version + 1 });
  });

  it('critère 2 : une tâche sans responsable donne ACTIVITY_WITHOUT_OWNER dans l’aperçu', async () => {
    const result = await say(
      consultantA,
      'ajoute une étape « Pointage de fin de journée » après la réalisation',
    );
    const proposal = result.proposal as ProposalDto;
    expect(proposal).not.toBeNull();
    expect(proposal.warnings.map((w) => w.code)).toContain('ACTIVITY_WITHOUT_OWNER');
    const discarded = await consultantA.call('POST', `${base}/proposals/${proposal.id}/discard`);
    expect(discarded.status).toBe(201);
    expect((discarded.body as ProposalDto).status).toBe('discarded');
    // Une proposition abandonnée ne s'applique plus.
    const again = await consultantA.call('POST', `${base}/proposals/${proposal.id}/apply`);
    expect(again.status).toBe(409);
    expect(list((await head()).model).some((e) => e.label === 'Pointage de fin de journée')).toBe(
      false,
    );
  });

  it('critère 3 : deux consultants modifient le même élément, le second reçoit `stale` puis régénère', async () => {
    const text = 'ajoute une étape « Relecture croisée » après la réalisation';
    const a = (await say(consultantA, text)).proposal as ProposalDto;
    const b = (await say(consultantB, text)).proposal as ProposalDto;
    expect(a.baseVersion).toBe(b.baseVersion);
    const appliedA = await consultantA.call('POST', `${base}/proposals/${a.id}/apply`);
    expect(appliedA.status, JSON.stringify(appliedA.body)).toBe(201);

    // L'aperçu de B est recalculé : les ensembles ne sont pas disjoints, la proposition est périmée.
    const preview = await consultantB.call('GET', `${base}/proposals/${b.id}`);
    expect((preview.body as ProposalDto).status).toBe('stale');
    const appliedB = await consultantB.call('POST', `${base}/proposals/${b.id}/apply`);
    expect(appliedB.status).toBe(409);

    const regenerated = await consultantB.call(
      'POST',
      `${base}/dialogue/proposals/${b.id}/regenerate`,
      { focus: { diagram: diagram() } },
    );
    expect(regenerated.status, JSON.stringify(regenerated.body)).toBe(201);
    const fresh = (regenerated.body as SendDialogueResult).proposal as ProposalDto;
    expect(fresh.status).toBe('pending');
    expect(fresh.baseVersion).toBe((await head()).version);
    expect(fresh.id).not.toBe(b.id);
    // Une proposition qui n'est pas périmée ne se régénère pas.
    const refused = await consultantB.call(
      'POST',
      `${base}/dialogue/proposals/${fresh.id}/regenerate`,
      {},
    );
    expect(refused.status).toBe(409);
    expect((await consultantB.call('POST', `${base}/proposals/${fresh.id}/discard`)).status).toBe(
      201,
    );
  });

  it('une proposition sur des éléments distincts est rebasée (« adapté à la version N »)', async () => {
    const a = (
      await say(consultantA, `renomme la tâche ${CONTROL_TASK} en « Revue des écritures »`)
    ).proposal as ProposalDto;
    const other = await say(
      consultantB,
      'ajoute une exception de relance à la tâche Relance des pièces manquantes',
      { diagram: `L2:${await processOf('Relances clients')}` },
    );
    const b = other.proposal as ProposalDto;
    expect((await consultantA.call('POST', `${base}/proposals/${a.id}/apply`)).status).toBe(201);
    const preview = (await consultantB.call('GET', `${base}/proposals/${b.id}`))
      .body as ProposalDto;
    expect(preview.status).toBe('pending');
    expect(preview.adaptedToVersion).toBe((await head()).version);
    expect((preview.changeSet as { baseVersion: number }).baseVersion).toBe(
      preview.adaptedToVersion,
    );
    const applied = await consultantB.call('POST', `${base}/proposals/${b.id}/apply`);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect((applied.body as { result: CommitResult }).result.rebasedFrom).toBe(a.baseVersion);
  });

  it('clarification : la question est stockée, la réponse complète la consigne', async () => {
    const first = await say(consultantA, 'ajoute une validation par le chef de mission');
    expect(first.proposal).toBeNull();
    expect(first.messages[1]).toMatchObject({ role: 'assistant', proposalId: null });
    expect(first.messages[1]?.content).toMatch(/endroit/);
    const second = await say(consultantA, 'après la préparation');
    expect(second.proposal).not.toBeNull();
    // Une consigne sans rapport après une proposition ne reprend pas l'ancienne.
    const third = await say(consultantA, 'bonjour');
    expect(third.proposal).toBeNull();
    expect(third.messages[1]?.content).toMatch(/Je n’ai pas compris/);
    await consultantA.call(
      'POST',
      `${base}/proposals/${(second.proposal as ProposalDto).id}/discard`,
    );
  });

  it('une cible introuvable donne un message de l’assistant, jamais une erreur', async () => {
    const unknown = await say(consultantA, 'supprime la tâche Inexistante');
    expect(unknown.proposal).toBeNull();
    expect(unknown.messages[1]?.content).toMatch(/Inexistante/);
  });

  it('le fil du dialogue et ses propositions se relisent', async () => {
    const res = await consultantA.call('GET', `${base}/dialogue`);
    expect(res.status).toBe(200);
    const dialogue = res.body as DialogueDto;
    expect(dialogue.messages.length).toBeGreaterThan(8);
    expect(dialogue.messages.map((m) => m.role)).toContain('assistant');
    const ids = dialogue.messages.flatMap((m) => (m.proposalId === null ? [] : [m.proposalId]));
    expect(dialogue.proposals.map((p) => p.id).sort()).toEqual([...new Set(ids)].sort());
    expect(dialogue.proposals.map((p) => p.status)).toEqual(
      expect.arrayContaining(['applied', 'discarded', 'stale']),
    );
    // Le validateur ne voit pas le fil (403) et les messages ne fuient pas entre missions (RLS).
    const rows = await admin.query('select count(*)::int as n from dialogue_messages');
    expect(rows.rows[0].n).toBe(dialogue.messages.length);
  });

  it('critère 4 : le retour arrière restaure le diagramme précédent', async () => {
    const all = await versions();
    const insertVersion = all.find(
      (v) => v.cause === 'dialogue_edit' && /validation/.test(v.summary ?? ''),
    );
    expect(insertVersion).toBeDefined();
    const target = (insertVersion as VersionSummary).version - 1;
    const beforeModel = (await consultantA.call('GET', `${base}/model?version=${target}`)).body as {
      model: BusinessModel;
    };
    const rolled = await consultantA.call('POST', `${base}/model/rollback`, { toVersion: target });
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(201);
    const now = await head();
    expect(now.version).toBe((rolled.body as CommitResult).version);
    expect(buildOutline(now.model, diagram())).toEqual(buildOutline(beforeModel.model, diagram()));
    expect(list(now.model).some((e) => e.label === 'Validation par le chef de mission')).toBe(
      false,
    );
    expect((await versions())[0]?.cause).toBe('rollback');
  });
});

async function processOf(label: string): Promise<string> {
  const { model } = await head();
  return list(model).find(
    (e) => e.kind === 'activity' && e.level === 'process' && e.label === label,
  )?.id as string;
}
