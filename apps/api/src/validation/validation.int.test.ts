import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@processia/config/env';
import type {
  CommentDto,
  DeliverablesPreviewDto,
  NoticeDto,
  NotificationDto,
  PresignedUrlDto,
  RunDto,
  SubmissionDto,
  SubmissionElementDto,
  SubmissionPreviewDto,
  ValidateSubmissionResult,
} from '@processia/contracts';
import { resetTestDatabase, resolveDbUrls, SEED_IDS, seedDevelopment } from '@processia/db';
import type { BusinessModel, Element } from '@processia/model';
import {
  PILOT_DESCRIPTION,
  PILOT_HYPOTHESES,
  pilotDeliverablesChangeSet,
} from '@processia/test-fixtures';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { RATE_LIMIT_OPTIONS } from '../auth/guards.js';
import { ENV } from '../env.js';
import { JobsService } from '../jobs/jobs.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { TestClient } from '../testing/http-client.js';

// Intégration WP-16 : exige `pnpm services:up` (PostgreSQL, MinIO, Mailpit) et un Chromium pour
// le PDF joint aux soumissions (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH). Application Nest réelle sur
// HTTP, worker pg-boss dans le même processus, fournisseur IA factice rejouant le pilote.

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const base = `/missions/${MISSION}`;
const NOW = '2026-11-27T09:00:00.000Z';
const STARTED = Date.now();

let app: INestApplication;
let baseUrl: string;
let admin: pg.Pool;
let manager: TestClient;
let consultantA: TestClient;
let consultantB: TestClient;
let validator: TestClient;
let notifications: NotificationsService;
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
  notifications = app.get(NotificationsService);
  manager = await client().signIn('responsable@processia.local');
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
  for (let i = 0; i < 600; i += 1) {
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
const byLabel = (m: BusinessModel, label: string): Element => {
  const found = list(m).find((e) => e.label === label);
  if (found === undefined) throw new Error(`Élément absent : ${label}`);
  return found;
};

async function run(path: string): Promise<void> {
  const res = await consultantA.call('POST', `${base}/${path}`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(await waitRun((res.body as { runId: string }).runId)).toMatchObject({
    status: 'succeeded',
  });
}

const accept = async (id: string) => {
  const res = await consultantA.call('POST', `${base}/elements/${id}/decision`, {
    decision: 'accept',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};

/** Renomme un élément (saisie directe du consultant) ; renvoie la version produite. */
async function rename(id: string, label: string): Promise<number> {
  const { version } = await head();
  const res = await consultantA.call('POST', `${base}/model/changes`, {
    changeSet: {
      baseVersion: version,
      ops: [{ op: 'update', id, set: { label } }],
      cause: 'dialogue_edit',
      summary: `Renommage en « ${label} »`,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { version: number }).version;
}

async function submissions(who: TestClient): Promise<SubmissionDto[]> {
  const res = await who.call('GET', `${base}/submissions`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as SubmissionDto[];
}

async function submit(kind: string, who: TestClient = consultantA): Promise<SubmissionDto> {
  const res = await who.call('POST', `${base}/submissions`, { kind });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as SubmissionDto;
}

/** Attend les trois exports joints à une soumission (tâches du worker). */
async function waitExports(id: string): Promise<SubmissionDto> {
  for (let i = 0; i < 400; i += 1) {
    const found = (await submissions(consultantA)).find((s) => s.id === id);
    if (found !== undefined && found.exports.length === 3) return found;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Exports de la soumission non terminés.');
}

/** Cherche un courriel de Mailpit reçu pendant ce test, pour un destinataire et un sujet. */
async function mailTo(address: string, subject: RegExp): Promise<{ Subject: string; ID: string }> {
  for (let i = 0; i < 40; i += 1) {
    await notifications.dispatchPending();
    const res = (await (await fetch('http://localhost:8025/api/v1/messages?limit=200')).json()) as {
      messages: { ID: string; Subject: string; Created: string; To: { Address: string }[] }[];
    };
    const found = res.messages.find(
      (m) =>
        Date.parse(m.Created) >= STARTED - 1000 &&
        m.To.some((to) => to.Address === address) &&
        subject.test(m.Subject),
    );
    if (found !== undefined) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Courriel introuvable pour ${address} (${String(subject)}).`);
}

let hypothesisLabels: string[] = [];
let preparedVersion = 0;
/** Hypothèses du scénario laissées sans décision (la seule acceptée est « Liasse fiscale »). */
let pending = 0;

describe('WP-16 : circuit de validation, portail du validateur, commentaires, signalements', () => {
  it('prépare le pilote : analyse, hypothèses laissées en attente, saisies du consultant', async () => {
    await setDescription(PILOT_DESCRIPTION);
    const res = await consultantA.call('POST', `${base}/analysis/extractions`, {});
    expect(res.status).toBe(201);
    expect((await waitRun(res.body.runId)).status).toBe('succeeded');
    await run('hypotheses/generate');
    const { model, version } = await head();
    hypothesisLabels = PILOT_HYPOTHESES.map((h) => h.proposal.label);
    await accept(byLabel(model, 'Liasse fiscale').id);
    const after = await head();
    const res2 = await consultantA.call('POST', `${base}/model/changes`, {
      changeSet: pilotDeliverablesChangeSet({
        baseVersion: after.version,
        userId: SEED_IDS.consultantA,
        at: NOW,
        idOf: (label) => byLabel(after.model, label).id,
      }),
    });
    expect(res2.status, JSON.stringify(res2.body)).toBe(201);
    const final = await head();
    preparedVersion = final.version;
    expect(preparedVersion).toBeGreaterThan(version);
    // Les autres hypothèses restent en attente : elles sont exclues de toute soumission.
    pending = hypothesisLabels.length - 1;
    expect(pending).toBeGreaterThanOrEqual(3);
    expect(list(final.model).filter((e) => e.status.value === 'hypothesis')).toHaveLength(pending);
  });

  it('critère 2 : avant la validation, la cartographie renvoie 409 PHASE_LOCKED', async () => {
    for (const who of [consultantA, manager]) {
      const res = await who.call('GET', `${base}/mapping`);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe('PHASE_LOCKED');
    }
    // Un droit refusé reste un 403 : le verrou de phase ne le masque pas.
    expect((await validator.call('GET', `${base}/mapping`)).status).toBe(403);
  });

  it('critère 4 : le validateur ne peut appeler aucune route model.edit (403) ni lire la tête', async () => {
    const calls: [string, string, unknown?][] = [
      [
        'POST',
        `${base}/model/changes`,
        { changeSet: { baseVersion: 1, ops: [], cause: 'extraction', summary: 'x' } },
      ],
      ['POST', `${base}/model/rollback`, { toVersion: 1 }],
      ['POST', `${base}/proposals/00000000-0000-7000-8000-00000000ffff/apply`, {}],
      ['POST', `${base}/analysis/extractions`, {}],
      ['POST', `${base}/hypotheses/generate`, {}],
      [
        'POST',
        `${base}/elements/00000000-0000-7000-8000-00000000ffff/decision`,
        { decision: 'accept' },
      ],
      ['GET', `${base}/model`],
      ['GET', `${base}/model/versions`],
      ['GET', `${base}/deliverables`],
      ['GET', `${base}/exports`],
      ['POST', `${base}/exports`, { format: 'docx' }],
      ['POST', `${base}/submissions`, { kind: 'analysis_dossier' }],
      ['GET', `${base}/submissions/preview?kind=analysis_dossier`],
    ];
    for (const [method, path, body] of calls) {
      const res = await validator.call(method, path, body);
      expect(res.status, `${method} ${path} : ${JSON.stringify(res.body)}`).toBe(403);
    }
  });

  it('aperçu avant soumission : version figée, éléments inclus, hypothèses exclues listées', async () => {
    const res = await consultantA.call('GET', `${base}/submissions/preview?kind=analysis_dossier`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const preview = res.body as SubmissionPreviewDto;
    expect(preview.modelVersion).toBe(preparedVersion);
    expect(preview.blocker).toBeNull();
    expect(preview.replaces).toBeNull();
    expect(preview.includedCount).toBeGreaterThan(0);
    expect(preview.excludedHypotheses).toHaveLength(pending);
    for (const label of hypothesisLabels.filter((l) => l !== 'Liasse fiscale')) {
      expect(preview.excludedHypotheses.map((h) => h.label)).toContain(label);
    }
    // AS-IS : pas avant la phase de cartographie.
    const asIs = await consultantA.call('GET', `${base}/submissions/preview?kind=as_is`);
    expect((asIs.body as SubmissionPreviewDto).blocker).toBe('WRONG_PHASE');
    expect(
      (await consultantA.call('POST', `${base}/submissions`, { kind: 'as_is' })).body.details,
    ).toMatchObject({ reason: 'WRONG_PHASE' });
  });

  let first: SubmissionDto;

  it('soumettre : version figée, hypothèses exclues au consultant, exports joints (sha256)', async () => {
    first = await submit('analysis_dossier');
    expect(first).toMatchObject({
      kind: 'analysis_dossier',
      round: 1,
      status: 'submitted',
      modelVersion: preparedVersion,
      excludedCount: pending,
    });
    expect(first.excludedHypotheses?.map((h) => h.label).sort()).toEqual(
      hypothesisLabels.filter((l) => l !== 'Liasse fiscale').sort(),
    );
    const done = await waitExports(first.id);
    expect(done.exports.map((e) => e.format).sort()).toEqual(['docx', 'pdf', 'xlsx']);
    for (const artifact of done.exports) {
      expect(artifact.modelVersion).toBe(preparedVersion);
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const stored = await admin.query(
      `select purpose, model_version from artifacts where id = any($1::uuid[])`,
      [done.exports.map((e) => e.id)],
    );
    expect(stored.rows.every((r) => r.purpose === 'submission')).toBe(true);
    // Ces exports n'encombrent pas la liste « Fichiers produits » de la page Livrables.
    const dossier = await consultantA.call('GET', `${base}/exports`);
    expect(
      (dossier.body as { id: string }[]).some((a) => done.exports.some((e) => e.id === a.id)),
    ).toBe(false);
  });

  it('notification in-app et courriel (Mailpit) au validateur à la soumission', async () => {
    const res = await validator.call('GET', '/notifications');
    expect(res.status).toBe(200);
    const mine = (res.body as NotificationDto[]).filter((n) => n.kind === 'submission.submitted');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.payload).toMatchObject({ submissionId: first.id, round: 1 });
    const mail = await mailTo('validateur@processia.local', /Dossier d’analyse à valider/);
    const detail = (await (
      await fetch(`http://localhost:8025/api/v1/message/${mail.ID}`)
    ).json()) as { Text: string };
    expect(detail.Text).toContain(`/missions/${MISSION}/validation`);
    // Le courriel n'est envoyé qu'une fois.
    expect(await notifications.dispatchPending()).toBe(0);
    // Les consultants ne reçoivent pas la notification du validateur.
    expect(
      ((await consultantA.call('GET', '/notifications')).body as NotificationDto[]).some(
        (n) => n.kind === 'submission.submitted',
      ),
    ).toBe(false);
  });

  it('le validateur lit la version figée, sans hypothèse, même quand la tête avance', async () => {
    const before = await validator.call('GET', `${base}/submissions/${first.id}/document`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const doc = before.body as DeliverablesPreviewDto;
    expect(doc.version).toBe(preparedVersion);
    for (const label of hypothesisLabels.filter((l) => l !== 'Liasse fiscale')) {
      expect(JSON.stringify(doc)).not.toContain(label);
    }
    expect(JSON.stringify(doc)).toContain('Liasse fiscale');

    const elements = (await validator.call('GET', `${base}/submissions/${first.id}/elements`))
      .body as SubmissionElementDto[];
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.every((e) => e.status !== 'hypothesis')).toBe(true);
    for (const label of hypothesisLabels.filter((l) => l !== 'Liasse fiscale')) {
      expect(elements.map((e) => e.label)).not.toContain(label);
    }

    // Le consultant continue de travailler : la tête avance, la version lue ne bouge pas.
    const { model } = await head();
    const target = byLabel(model, 'Liasse fiscale');
    const newer = await rename(target.id, 'Liasse fiscale (révisée)');
    expect(newer).toBeGreaterThan(preparedVersion);
    const after = (await validator.call('GET', `${base}/submissions/${first.id}/document`))
      .body as DeliverablesPreviewDto;
    expect(after.version).toBe(preparedVersion);
    expect(JSON.stringify(after)).not.toContain('(révisée)');
    await rename(target.id, 'Liasse fiscale');
  });

  it('le validateur télécharge les exports joints : empreinte sha256 identique', async () => {
    const mine = (await submissions(validator)).find((s) => s.id === first.id);
    expect(mine?.exports).toHaveLength(3);
    expect(mine?.excludedHypotheses).toBeUndefined();
    expect(mine?.excludedCount).toBe(pending);
    for (const artifact of mine?.exports ?? []) {
      const res = await validator.call(
        'GET',
        `${base}/submissions/${first.id}/exports/${artifact.id}/download-url`,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const file = await fetch((res.body as PresignedUrlDto).url);
      expect(file.status).toBe(200);
      const bytes = Buffer.from(await file.arrayBuffer());
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    }
    // Un artefact qui n'est pas joint à la soumission reste introuvable.
    expect(
      (
        await validator.call(
          'GET',
          `${base}/submissions/${first.id}/exports/00000000-0000-7000-8000-00000000ffff/download-url`,
        )
      ).status,
    ).toBe(404);
    // L'export de la tête (dossier de travail) reste fermé au validateur.
    expect((await validator.call('GET', `${base}/exports`)).status).toBe(403);
  });

  let thread: CommentDto;

  it('commentaires : le validateur commente la version figée, le consultant répond, fil résolu', async () => {
    const elements = (await validator.call('GET', `${base}/submissions/${first.id}/elements`))
      .body as SubmissionElementDto[];
    const element = elements[0];
    expect(element).toBeDefined();
    const created = await validator.call('POST', `${base}/comments`, {
      targetKind: 'element',
      targetId: element?.id,
      submissionId: first.id,
      body: 'Cet élément est-il complet ?',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    thread = created.body as CommentDto;
    expect(thread).toMatchObject({
      author: { role: 'validator' },
      modelVersion: preparedVersion,
      submissionId: first.id,
    });
    // Commentaire sur la soumission et sur un livrable.
    for (const [targetKind, targetId] of [
      ['submission', first.id],
      ['deliverable', 'actors_raci'],
    ] as const) {
      const res = await validator.call('POST', `${base}/comments`, {
        targetKind,
        targetId,
        submissionId: first.id,
        body: `Remarque sur ${targetKind}`,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const reply = await consultantA.call('POST', `${base}/comments`, {
      targetKind: 'element',
      targetId: element?.id,
      submissionId: first.id,
      parentId: thread.id,
      body: 'Oui, confirmé avec le client.',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.author.role).toBe('team');
    const seen = (
      await validator.call('GET', `${base}/comments?targetKind=element&targetId=${element?.id}`)
    ).body as CommentDto[];
    expect(seen.map((c) => c.body)).toEqual([
      'Cet élément est-il complet ?',
      'Oui, confirmé avec le client.',
    ]);
    // Notification in-app à l'autre camp, sans courriel.
    const note = ((await consultantA.call('GET', '/notifications')).body as NotificationDto[]).find(
      (n) => n.kind === 'comment.created',
    );
    expect(note).toBeDefined();
    const resolved = await consultantA.call('POST', `${base}/comments/${thread.id}/resolve`, {
      resolved: true,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolvedAt).not.toBeNull();
  });

  it('commentaires : cibles inconnues refusées, commentaires internes jamais visibles du validateur', async () => {
    // Le validateur ne commente que sur une soumission.
    const bare = await validator.call('POST', `${base}/comments`, {
      targetKind: 'element',
      targetId: 'x',
      body: 'Sans soumission',
    });
    expect(bare.status).toBe(403);
    // Une hypothèse n'est pas une cible : elle n'existe pas dans la version figée du validateur.
    const { model } = await head();
    const hypothesis = byLabel(model, 'Logiciel de GED');
    expect(hypothesis.status.value).toBe('hypothesis');
    const refused = await validator.call('POST', `${base}/comments`, {
      targetKind: 'element',
      targetId: hypothesis.id,
      submissionId: first.id,
      body: 'Et celui-ci ?',
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    // Commentaire interne (équipe) sur l'hypothèse : invisible du validateur.
    const internal = await consultantA.call('POST', `${base}/comments`, {
      targetKind: 'element',
      targetId: hypothesis.id,
      body: 'À discuter en interne.',
    });
    expect(internal.status, JSON.stringify(internal.body)).toBe(201);
    expect(internal.body.submissionId).toBeNull();
    const all = (await validator.call('GET', `${base}/comments`)).body as CommentDto[];
    expect(all.some((c) => c.body === 'À discuter en interne.')).toBe(false);
    const team = (await consultantB.call('GET', `${base}/comments`)).body as CommentDto[];
    expect(team.some((c) => c.body === 'À discuter en interne.')).toBe(true);
    // Le validateur ne peut pas résoudre un commentaire interne.
    expect(
      (
        await validator.call('POST', `${base}/comments/${internal.body.id}/resolve`, {
          resolved: true,
        })
      ).status,
    ).toBe(404);
    // Corps vide ou trop long : 400.
    expect(
      (
        await consultantA.call('POST', `${base}/comments`, {
          targetKind: 'submission',
          targetId: first.id,
          submissionId: first.id,
          body: '   ',
        })
      ).status,
    ).toBe(400);
  });

  let second: SubmissionDto;

  it('critère 5 : une nouvelle soumission passe la précédente à superseded', async () => {
    second = await submit('analysis_dossier', consultantB);
    expect(second.round).toBe(2);
    const states = Object.fromEntries(
      (await submissions(consultantA)).map((s) => [s.round, s.status]),
    );
    expect(states).toEqual({ 1: 'superseded', 2: 'submitted' });
    // La soumission remplacée ne peut plus être validée ; le validateur la lit toujours.
    const refused = await validator.call('POST', `${base}/submissions/${first.id}/validate`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({ reason: 'NOT_SUBMITTED' });
    expect((await validator.call('GET', `${base}/submissions/${first.id}/document`)).status).toBe(
      200,
    );
    // Un fil d'une soumission remplacée n'accepte plus de commentaire.
    const late = await validator.call('POST', `${base}/comments`, {
      targetKind: 'submission',
      targetId: first.id,
      submissionId: first.id,
      body: 'Trop tard',
    });
    expect(late.status).toBe(409);
    await waitExports(second.id);
  });

  it('retirer une soumission : invisible du validateur ; remplacer : explicite', async () => {
    const withdrawn = await consultantA.call(
      'POST',
      `${base}/submissions/${second.id}/withdraw`,
      {},
    );
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.status).toBe('withdrawn');
    expect((await submissions(validator)).some((s) => s.id === second.id)).toBe(false);
    expect((await validator.call('GET', `${base}/submissions/${second.id}`)).status).toBe(404);
    expect((await validator.call('GET', `${base}/submissions/${second.id}/document`)).status).toBe(
      404,
    );
    // Retrait d'une soumission déjà retirée : 409. Le validateur ne retire rien : 403.
    expect(
      (await consultantA.call('POST', `${base}/submissions/${second.id}/withdraw`, {})).status,
    ).toBe(409);
    expect(
      (await validator.call('POST', `${base}/submissions/${second.id}/withdraw`, {})).status,
    ).toBe(403);
    // Remplacer une soumission retirée est refusé ; une soumission en cours se remplace.
    expect(
      (await consultantA.call('POST', `${base}/submissions/${second.id}/replace`, {})).status,
    ).toBe(409);
    const third = await submit('analysis_dossier');
    expect(third.round).toBe(3);
    const fourth = await consultantA.call('POST', `${base}/submissions/${third.id}/replace`, {});
    expect(fourth.status, JSON.stringify(fourth.body)).toBe(201);
    expect(fourth.body.round).toBe(4);
    const states = Object.fromEntries(
      (await submissions(consultantA)).map((s) => [s.round, s.status]),
    );
    expect(states).toEqual({ 1: 'superseded', 2: 'withdrawn', 3: 'superseded', 4: 'submitted' });
    second = fourth.body as SubmissionDto;
    await waitExports(second.id);
  });

  it('droits de décision : seuls le validateur de la mission décide ; le TO-BE se décide par élément', async () => {
    for (const who of [consultantA, manager]) {
      const res = await who.call('POST', `${base}/submissions/${second.id}/validate`, {});
      expect(res.status).toBe(403);
    }
    const admin2 = await client().signIn('admin@processia.local');
    expect(
      (await admin2.call('POST', `${base}/submissions/${second.id}/validate`, {})).status,
    ).toBe(403);
    expect((await admin2.call('GET', `${base}/submissions`)).status).toBe(200);
    // Le validateur n'a accès à aucune autre mission : 404.
    expect(
      (await validator.call('GET', '/missions/00000000-0000-7000-8000-00000000ffff/submissions'))
        .status,
    ).toBe(404);
  });

  let validated: ValidateSubmissionResult;
  let skippedLabel = '';

  it('critère 1 : le validateur valide ; éléments validated, soumission validated, phase mapping', async () => {
    // Un élément modifié après la soumission ne passe pas à `validated` (version figée ≠ tête).
    const { model } = await head();
    const touched = list(model).find((e) => e.kind === 'actor' && e.status.value !== 'hypothesis');
    expect(touched).toBeDefined();
    skippedLabel = `${touched?.label ?? ''} (modifié)`;
    await rename(touched?.id ?? '', skippedLabel);
    const headBefore = (await head()).version;

    const res = await validator.call('POST', `${base}/submissions/${second.id}/validate`, {
      comment: 'Dossier conforme.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    validated = res.body as ValidateSubmissionResult;
    expect(validated.phase).toBe('mapping');
    expect(validated.validatedCount).toBeGreaterThan(0);
    expect(validated.version).toBe(headBefore + 1);
    expect(validated.skippedChangedIds).toContain(touched?.id);
    expect(validated.submission).toMatchObject({
      status: 'validated',
      comment: 'Dossier conforme.',
      decidedBy: { id: SEED_IDS.validator },
    });

    const final = await head();
    expect(final.version).toBe(validated.version);
    const delivered = (
      (await validator.call('GET', `${base}/submissions/${second.id}/elements`))
        .body as SubmissionElementDto[]
    ).map((e) => e.id);
    for (const id of delivered) {
      const element = final.model.elements[id];
      if (id === touched?.id) {
        expect(element?.status.value).not.toBe('validated');
        continue;
      }
      expect(element?.status.value, element?.label).toBe('validated');
      expect(element?.status.validatedInSubmission).toBe(second.id);
      expect(element?.status.decidedBy).toBe(SEED_IDS.validator);
    }
    // Les hypothèses ne sont pas validées : elles restent à décider par le consultant.
    expect(list(final.model).filter((e) => e.status.value === 'hypothesis')).toHaveLength(pending);
    // ChangeSet de cause `validation`.
    const versions = (await consultantA.call('GET', `${base}/model/versions`)).body as {
      version: number;
      cause: string;
      authorId: string;
    }[];
    expect(versions.find((v) => v.version === validated.version)).toMatchObject({
      cause: 'validation',
      authorId: SEED_IDS.validator,
    });

    const mission = (await consultantA.call('GET', `/missions/${MISSION}`)).body;
    expect(mission.phase).toBe('mapping');
  });

  it('critère 2 (suite) : la cartographie est ouverte ; PO-31 interdit le retour à l’analyse', async () => {
    const open = await consultantA.call('GET', `${base}/mapping`);
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(open.body).toMatchObject({ phase: 'mapping', unlocked: true });
    const back = await manager.call('PATCH', `/missions/${MISSION}`, { phase: 'analysis' });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('PHASE_REGRESSION');
    // Le dossier validé ne se valide ni ne se soumet une seconde fois.
    expect(
      (await validator.call('POST', `${base}/submissions/${second.id}/validate`, {})).status,
    ).toBe(409);
    const again = await consultantA.call('POST', `${base}/submissions`, {
      kind: 'analysis_dossier',
    });
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'ALREADY_VALIDATED' });
    // Courriel de validation à l'équipe.
    await mailTo('consultante1@processia.local', /Dossier d’analyse validé/);
  });

  let noticeIds: string[] = [];

  it('critère 3 : modifier un élément validé crée un signalement visible du validateur et un courriel', async () => {
    const { model } = await head();
    const target = list(model).find(
      (e) => e.status.value === 'validated' && e.label === 'Liasse fiscale',
    );
    expect(target).toBeDefined();
    const version = await rename(target?.id ?? '', 'Liasse fiscale (corrigée)');
    const after = (await head()).model.elements[target?.id ?? ''];
    expect(after?.status.value).toBe('confirmed');
    expect(after?.status.changedAfterValidation?.version).toBe(version);

    const notices = (await validator.call('GET', `${base}/notices`)).body as NoticeDto[];
    const mine = notices.filter((n) => n.version === version);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      elementId: target?.id,
      submissionId: second.id,
      seenAt: null,
    });
    expect(mine[0]?.summary).toContain('Liasse fiscale');
    noticeIds = mine.map((n) => n.id);

    const note = ((await validator.call('GET', '/notifications')).body as NotificationDto[]).find(
      (n) => n.kind === 'post_validation_notice',
    );
    expect(note?.payload).toMatchObject({ version, noticeIds });
    const mail = await mailTo('validateur@processia.local', /modification après validation/);
    const detail = (await (
      await fetch(`http://localhost:8025/api/v1/message/${mail.ID}`)
    ).json()) as { Text: string };
    expect(detail.Text).toContain('Liasse fiscale');
    expect(detail.Text).toContain(`version ${version}`);

    // Les consultants voient les signalements mais ne les marquent pas comme vus.
    expect(((await consultantA.call('GET', `${base}/notices`)).body as NoticeDto[]).length).toBe(
      notices.length,
    );
    expect((await consultantA.call('POST', `${base}/notices/seen`, { noticeIds })).status).toBe(
      403,
    );
  });

  it('signalements : le validateur marque comme vus (seen_at posé une seule fois)', async () => {
    const first = await validator.call('POST', `${base}/notices/seen`, { noticeIds });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.updated).toBe(noticeIds.length);
    const again = await validator.call('POST', `${base}/notices/seen`, { noticeIds });
    expect(again.body.updated).toBe(0);
    const notices = (await validator.call('GET', `${base}/notices`)).body as NoticeDto[];
    expect(notices.filter((n) => noticeIds.includes(n.id)).every((n) => n.seenAt !== null)).toBe(
      true,
    );
    expect((await validator.call('POST', `${base}/notices/seen`, { noticeIds: [] })).status).toBe(
      400,
    );
  });

  it('notifications : liste, marquage lu', async () => {
    const mine = (await validator.call('GET', '/notifications')).body as NotificationDto[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((n) => n.readAt === null)).toBe(true);
    const res = await validator.call('POST', '/notifications/read', { ids: [mine[0]?.id] });
    expect(res.body.updated).toBe(1);
    const all = await validator.call('POST', '/notifications/read', {});
    expect(all.body.updated).toBe(mine.length - 1);
    // Cloisonnement : on ne marque pas les notifications d'autrui.
    const others = (await consultantA.call('GET', '/notifications')).body as NotificationDto[];
    expect(others.every((n) => n.readAt === null)).toBe(true);
  });

  it('AS-IS : soumission générique ; la validation fait passer la mission en transformation', async () => {
    const preview = (await consultantA.call('GET', `${base}/submissions/preview?kind=as_is`))
      .body as SubmissionPreviewDto;
    expect(preview.blocker).toBeNull();
    const asIs = await submit('as_is');
    expect(asIs).toMatchObject({ kind: 'as_is', round: 1, status: 'submitted' });
    const res = await validator.call('POST', `${base}/submissions/${asIs.id}/validate`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.phase).toBe('transformation');
    const back = await manager.call('PATCH', `/missions/${MISSION}`, { phase: 'mapping' });
    expect(back.body.code).toBe('PHASE_REGRESSION');
    // TO-BE : la validation se fait élément par élément (WP-23), pas en bloc.
    const toBe = await submit('to_be');
    const refused = await validator.call('POST', `${base}/submissions/${toBe.id}/validate`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({ reason: 'DECIDE_PER_ELEMENT' });
  });

  it('une exportation manquante se relance (409 si le format est déjà joint)', async () => {
    const mine = (await submissions(consultantA)).find((s) => s.round === 4);
    expect(mine?.exports).toHaveLength(3);
    const res = await consultantA.call('POST', `${base}/submissions/${mine?.id}/exports`, {
      format: 'docx',
    });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'EXPORT_EXISTS' });
    const valid = await validator.call('POST', `${base}/submissions/${mine?.id}/exports`, {
      format: 'docx',
    });
    expect(valid.status).toBe(409);
  });
});
