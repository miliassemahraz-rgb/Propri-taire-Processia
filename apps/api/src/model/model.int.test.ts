import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@processia/config/env';
import {
  resetTestDatabase,
  resolveDbUrls,
  SEED_IDS,
  seedDevelopment,
  withMission,
  type Database,
} from '@processia/db';
import { buildActor, tempId, type ChangeSet, type Element, type ModelDiff } from '@processia/model';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { RATE_LIMIT_OPTIONS } from '../auth/guards.js';
import { DB } from '../db/db.module.js';
import { ENV } from '../env.js';
import { TestClient, type Reply } from '../testing/http-client.js';
import { ModelService } from './model.service.js';
import { ProposalsService } from './proposals.service.js';

// Intégration WP-08 : exige `pnpm services:up`. Application Nest réelle sur HTTP, base
// `processia_test`, rôle `processia_app` (soumis à la RLS). Mission du seed, sans version au départ.

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const base = `/missions/${MISSION}`;

let app: INestApplication;
let baseUrl: string;
let admin: pg.Pool;
let db: Database;
let models: ModelService;
let proposals: ProposalsService;
const client = () => new TestClient(() => baseUrl);
let consultantA: TestClient;
let consultantB: TestClient;
let managerC: TestClient;
let validatorC: TestClient;
let adminC: TestClient;
let listener: pg.Client;
const events: { missionId: string; version: number }[] = [];

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
  db = app.get<Database>(DB);
  models = app.get(ModelService);
  proposals = app.get(ProposalsService);
  consultantA = await client().signIn('consultante1@processia.local');
  consultantB = await client().signIn('consultant2@processia.local');
  managerC = await client().signIn('responsable@processia.local');
  validatorC = await client().signIn('validateur@processia.local');
  adminC = await client().signIn('admin@processia.local');
  listener = new pg.Client({ connectionString: urls.admin });
  await listener.connect();
  await listener.query('LISTEN mission_events');
  listener.on('notification', (n) => {
    if (n.channel === 'mission_events' && n.payload) events.push(JSON.parse(n.payload));
  });
});

afterAll(async () => {
  await listener.end();
  await app.close();
  await admin.end();
});

const actor = (n: number, label: string): ChangeSet['ops'][number] => ({
  op: 'add',
  element: buildActor({ id: tempId(n), code: `ACT-0${n}`, label }) as Element,
});

const cs = (baseVersion: number, ops: ChangeSet['ops'], summary = 'Test'): ChangeSet => ({
  baseVersion,
  ops,
  cause: 'dialogue_edit',
  summary,
});

const commit = (c: TestClient, changeSet: ChangeSet): Promise<Reply> =>
  c.call('POST', `${base}/model/changes`, { changeSet });

const relabel = (id: string, label: string): ChangeSet['ops'] => [
  { op: 'update', id, set: { label } },
];

const head = async (): Promise<number> =>
  (await consultantA.call('GET', `${base}/model`)).body.version as number;

const elementIds: Record<string, string> = {};

describe('WP-08 : persistance versionnée du modèle', () => {
  it('crée la version 1 : instantané, index par élément, tête de mission et pg_notify', async () => {
    expect(await head()).toBe(0);
    const res = await commit(
      consultantA,
      cs(0, [actor(1, 'Comptable'), actor(2, 'Client'), actor(3, 'Assistante')], 'Trois acteurs'),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.version).toBe(1);
    expect(res.body.diff.added).toHaveLength(3);
    expect(res.body.rebasedFrom).toBeNull();

    const model = (await consultantA.call('GET', `${base}/model`)).body;
    expect(model.version).toBe(1);
    const els = Object.values(model.model.elements) as Element[];
    for (const e of els) elementIds[e.label] = e.id;
    expect(els.map((e) => e.code).sort()).toEqual(['ACT-01', 'ACT-02', 'ACT-03']);
    expect(els.every((e) => /^[0-9a-f-]{36}$/.test(e.id) && e.id[14] === '7')).toBe(true);

    const rows = await admin.query(
      `select element_id, change from model_version_elements where mission_id = $1 and version = 1`,
      [MISSION],
    );
    expect(rows.rows).toHaveLength(3);
    expect(new Set(rows.rows.map((r) => r.change))).toEqual(new Set(['added']));
    const head1 = await admin.query(`select head_version from missions where id = $1`, [MISSION]);
    expect(head1.rows[0].head_version).toBe(1);
    const ver = await admin.query(
      `select cause, summary, author_id, parent_version from model_versions where mission_id = $1 and version = 1`,
      [MISSION],
    );
    expect(ver.rows[0]).toMatchObject({
      cause: 'dialogue_edit',
      summary: 'Trois acteurs',
      author_id: SEED_IDS.consultantA,
      parent_version: null,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toContainEqual({ missionId: MISSION, version: 1 });
  });

  it('lecture : versions, version donnée, différence entre deux versions', async () => {
    const versions = await consultantA.call('GET', `${base}/model/versions`);
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([1]);
    expect((await consultantA.call('GET', `${base}/model?version=1`)).body.version).toBe(1);
    expect((await consultantA.call('GET', `${base}/model?version=9`)).status).toBe(404);
    expect((await consultantA.call('GET', `${base}/model?version=abc`)).status).toBe(400);
    const diff = await consultantA.call('GET', `${base}/model/diff?from=0&to=1`);
    expect(diff.status).toBe(200);
    expect(diff.body.added).toHaveLength(3);
    // Lecture ouverte à l'administrateur (observateur), pas au validateur (matrice 3.5).
    expect((await adminC.call('GET', `${base}/model`)).status).toBe(200);
    expect((await validatorC.call('GET', `${base}/model`)).status).toBe(403);
  });

  it('1. deux commits concurrents sur des éléments disjoints : les deux réussissent (rebasage)', async () => {
    const [a, b] = await Promise.all([
      commit(consultantA, cs(1, relabel(elementIds['Comptable']!, 'Comptable senior'))),
      commit(consultantB, cs(1, relabel(elementIds['Client']!, 'Client final'))),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.version, b.body.version].sort()).toEqual([2, 3]);
    // Celui qui passe en second est rebasé sur la tête.
    const rebased = [a, b].find((r) => r.body.version === 3)!;
    expect(rebased.body.rebasedFrom).toBe(1);
    const final = (await consultantA.call('GET', `${base}/model`)).body.model.elements;
    expect(final[elementIds['Comptable']!].label).toBe('Comptable senior');
    expect(final[elementIds['Client']!].label).toBe('Client final');
  });

  it('2. deux commits sur le même élément : le second renvoie 409 STALE', async () => {
    const h = await head();
    const first = await commit(
      consultantA,
      cs(h, relabel(elementIds['Assistante']!, 'Assistante A')),
    );
    expect(first.status).toBe(201);
    const second = await commit(
      consultantB,
      cs(h, relabel(elementIds['Assistante']!, 'Assistante B')),
    );
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('STALE');
    expect(second.body.details.conflicts).toEqual([elementIds['Assistante']]);
    expect(second.body.details.headVersion).toBe(first.body.version);
    // Rien n'a été écrit par le second.
    expect(await head()).toBe(first.body.version);
    // Version de départ future : aussi refusée.
    expect((await commit(consultantB, cs(99, []))).status).toBe(409);
  });

  it('refuse un ChangeSet que les règles du modèle rejettent (422) ou mal formé (400)', async () => {
    const h = await head();
    const bad = await commit(
      consultantA,
      cs(h, [{ op: 'update', id: '01900000-0000-7000-8000-00000000dead', set: { label: 'x' } }]),
    );
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('CHANGESET_INVALID');
    expect(await head()).toBe(h);
    expect(
      (await consultantA.call('POST', `${base}/model/changes`, { changeSet: {} })).status,
    ).toBe(400);
    // Droits : le validateur et l'administrateur n'écrivent pas le modèle.
    expect((await commit(validatorC, cs(h, []))).status).toBe(403);
    expect((await commit(adminC, cs(h, []))).status).toBe(403);
  });

  it('5. l’historique d’un élément liste exactement les versions qui l’ont touché', async () => {
    const h = await head();
    // Référence indépendante : on compare chaque couple de versions consécutives par l'API de diff.
    const touched = (id: string, diffs: ModelDiff[]): number[] =>
      diffs
        .map((d, i) =>
          d.added.includes(id) || d.removed.includes(id) || d.modified.some((m) => m.id === id)
            ? i + 1
            : 0,
        )
        .filter((v) => v > 0);
    const diffs: ModelDiff[] = [];
    for (let v = 1; v <= h; v++) {
      diffs.push((await consultantA.call('GET', `${base}/model/diff?from=${v - 1}&to=${v}`)).body);
    }
    for (const [name, id] of Object.entries(elementIds)) {
      const history = await consultantA.call('GET', `${base}/elements/${id}/history`);
      expect(history.status).toBe(200);
      const versions = history.body.map((e: { version: number }) => e.version);
      expect(versions).toEqual(touched(id, diffs).reverse());
      expect(history.body.at(-1).change).toBe('added');
      expect(history.body[0]).toMatchObject({ cause: 'dialogue_edit' });
      expect(name).toBeTruthy();
    }
    // Les versions qui n'ont touché ni l'un ni l'autre n'y figurent pas.
    const comptable = await consultantA.call(
      'GET',
      `${base}/elements/${elementIds['Comptable']}/history`,
    );
    expect(comptable.body.map((e: { change: string }) => e.change)).toEqual(['updated', 'added']);
    expect(
      (
        await consultantA.call(
          'GET',
          `${base}/elements/01900000-0000-7000-8000-00000000dead/history`,
        )
      ).status,
    ).toBe(404);
  });

  it('4. modifier un élément validated le repasse à confirmed, crée un signalement et notifie le validateur', async () => {
    const id = elementIds['Comptable']!;
    // Soumission de validation (WP-16 la créera ; ici une ligne suffit) puis validation par le validateur.
    const sub = await admin.query(
      `insert into validation_submissions (mission_id, kind, round, model_version, submitted_by)
       values ($1, 'analysis_dossier', 1, $2, $3) returning id`,
      [MISSION, await head(), SEED_IDS.manager],
    );
    const submissionId = sub.rows[0].id as string;
    const h = await head();
    const validated = await models.commit(
      MISSION,
      cs(h, [{ op: 'set_status', id, status: 'validated' }], 'Validation'),
      { userId: SEED_IDS.validator, actor: 'validator' },
      { submissionId },
    );
    expect(validated.noticedElementIds).toEqual([]);
    const before = (await consultantA.call('GET', `${base}/model`)).body.model.elements[id];
    expect(before.status.value).toBe('validated');
    expect(before.status.validatedInSubmission).toBe(submissionId);

    const edited = await commit(
      consultantA,
      cs(validated.version, relabel(id, 'Comptable principal'), 'Retouche après validation'),
    );
    expect(edited.status).toBe(201);
    expect(edited.body.noticedElementIds).toEqual([id]);
    const after = (await consultantA.call('GET', `${base}/model`)).body.model.elements[id];
    expect(after.status.value).toBe('confirmed');
    expect(after.status.changedAfterValidation.version).toBe(edited.body.version);

    const notices = await admin.query(
      `select * from post_validation_notices where mission_id = $1`,
      [MISSION],
    );
    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0]).toMatchObject({
      element_id: id,
      submission_id: submissionId,
      version: edited.body.version,
    });
    expect(notices.rows[0].summary).toMatch(/modifié après validation/);
    const notes = await admin.query(`select * from notifications where mission_id = $1`, [MISSION]);
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]).toMatchObject({
      user_id: SEED_IDS.validator,
      kind: 'post_validation_notice',
      read_at: null,
    });
    expect(notes.rows[0].payload.elementIds).toEqual([id]);

    // Une modification qui ne touche pas un élément validé n'en crée aucune.
    const other = await commit(
      consultantA,
      cs(edited.body.version, relabel(elementIds['Client']!, 'Client 2')),
    );
    expect(other.body.noticedElementIds).toEqual([]);
    expect(
      (await admin.query(`select count(*)::int as n from post_validation_notices`)).rows[0].n,
    ).toBe(1);
  });

  it('3. le retour arrière crée la version N+1 avec le contenu de K', async () => {
    const h = await head();
    const k = 2;
    const target = (await consultantA.call('GET', `${base}/model?version=${k}`)).body.model;
    const res = await consultantB.call('POST', `${base}/model/rollback`, { toVersion: k });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(h + 1);
    const restored = (await consultantA.call('GET', `${base}/model`)).body;
    expect(restored.version).toBe(h + 1);
    const strip = (m: { elements: Record<string, Element> }) =>
      Object.fromEntries(
        Object.entries(m.elements).map(([i, e]) => [i, { ...e, meta: undefined }]),
      );
    expect(strip(restored.model)).toEqual(strip(target));
    // Aucune version n'est supprimée ; la nouvelle porte la cause « rollback ».
    const versions = (await consultantA.call('GET', `${base}/model/versions`)).body;
    expect(versions).toHaveLength(h + 1);
    expect(versions[0]).toMatchObject({ version: h + 1, cause: 'rollback', parentVersion: h });
    expect((await consultantA.call('GET', `${base}/model?version=${k}`)).body.version).toBe(k);
    // Droits et bornes.
    expect((await validatorC.call('POST', `${base}/model/rollback`, { toVersion: 1 })).status).toBe(
      403,
    );
    expect((await adminC.call('POST', `${base}/model/rollback`, { toVersion: 1 })).status).toBe(
      403,
    );
    expect(
      (await consultantA.call('POST', `${base}/model/rollback`, { toVersion: h + 1 })).status,
    ).toBe(400);
    expect(
      (await consultantA.call('POST', `${base}/model/rollback`, { toVersion: 0 })).status,
    ).toBe(400);
  });

  it('un retour arrière qui touche un élément validé le repasse à confirmed avec un signalement', async () => {
    const id = elementIds['Assistante']!;
    const sub = await admin.query(`select id from validation_submissions limit 1`);
    const submissionId = sub.rows[0].id as string;
    let h = await head();
    const relabelled = await commit(consultantA, cs(h, relabel(id, 'Assistante renommée')));
    expect(relabelled.status).toBe(201);
    h = await head();
    const labelBefore = (await consultantA.call('GET', `${base}/model`)).body.model.elements[id]
      .label as string;
    await models.commit(
      MISSION,
      cs(h, [{ op: 'set_status', id, status: 'validated' }]),
      { userId: SEED_IDS.validator, actor: 'validator' },
      { submissionId },
    );
    h = await head();
    const noticesBefore = (
      await admin.query(`select count(*)::int as n from post_validation_notices`)
    ).rows[0].n as number;
    // La version 1 portait le libellé d'origine de l'assistante.
    const res = await managerC.call('POST', `${base}/model/rollback`, { toVersion: 1 });
    expect(res.status).toBe(201);
    expect(res.body.noticedElementIds).toContain(id);
    const el = (await consultantA.call('GET', `${base}/model`)).body.model.elements[id];
    expect(el.label).toBe('Assistante');
    expect(el.label).not.toBe(labelBefore);
    expect(el.status.value).toBe('confirmed');
    expect(el.status.changedAfterValidation.version).toBe(h + 1);
    const noticesAfter = (
      await admin.query(`select count(*)::int as n from post_validation_notices`)
    ).rows[0].n as number;
    expect(noticesAfter).toBeGreaterThan(noticesBefore);
  });
});

describe('WP-08 : propositions de changement', () => {
  const ids: Record<string, string> = {};

  const create = async (name: string, baseVersion: number, ops: ChangeSet['ops']) => {
    const p = await withMission(db, MISSION, (tx) =>
      proposals.create(tx, MISSION, {
        baseVersion,
        instruction: `Instruction ${name}`,
        changeSet: cs(baseVersion, ops, name),
        explanation: 'Explication',
        createdBy: SEED_IDS.consultantA,
      }),
    );
    ids[name] = p.id;
    return p;
  };
  const status = async (name: string): Promise<string> => {
    const list = (await consultantA.call('GET', `${base}/proposals`)).body as {
      id: string;
      status: string;
    }[];
    return list.find((p) => p.id === ids[name])!.status;
  };

  it('création et aperçu : aucune modification du modèle avant « apply »', async () => {
    const h = await head();
    const comptable = elementIds['Comptable']!;
    const client_ = elementIds['Client']!;
    const p1 = await create('P1', h, relabel(comptable, 'Via P1'));
    await create('P2', h, relabel(client_, 'Via P2'));
    await create('P3', h, relabel(comptable, 'Via P3'));
    expect(p1.status).toBe('pending');
    expect(p1.diff?.modified).toEqual([{ id: comptable, fields: ['label'] }]);
    const preview = await consultantA.call('GET', `${base}/proposals/${ids['P1']}`);
    expect(preview.status).toBe(200);
    expect(preview.body.diff.modified[0].id).toBe(comptable);
    expect(preview.body.adaptedToVersion).toBeNull();
    expect(await head()).toBe(h);
    // Un ChangeSet invalide n'est pas enregistré.
    await expect(
      create('PX', h, [
        { op: 'update', id: '01900000-0000-7000-8000-00000000dead', set: { label: 'x' } },
      ]),
    ).rejects.toMatchObject({ code: 'CHANGESET_INVALID' });
  });

  it('application : nouvelle version, proposition liée ; les conflictuelles passent en stale', async () => {
    const h = await head();
    const denied = await validatorC.call('POST', `${base}/proposals/${ids['P1']}/apply`);
    expect(denied.status).toBe(403);
    const res = await consultantA.call('POST', `${base}/proposals/${ids['P1']}/apply`);
    expect(res.status).toBe(201);
    expect(res.body.result.version).toBe(h + 1);
    expect(res.body.proposal).toMatchObject({ status: 'applied', appliedVersion: h + 1 });
    expect(
      (await consultantA.call('GET', `${base}/model`)).body.model.elements[elementIds['Comptable']!]
        .label,
    ).toBe('Via P1');
    // P3 touche le même champ que P1 : passage en stale ; P2 est disjointe : reste applicable.
    expect(await status('P3')).toBe('stale');
    expect(await status('P2')).toBe('pending');
    const preview = await consultantA.call('GET', `${base}/proposals/${ids['P2']}`);
    expect(preview.body.adaptedToVersion).toBe(h + 1);
    // Une proposition déjà appliquée ou périmée ne s'applique plus.
    expect((await consultantA.call('POST', `${base}/proposals/${ids['P1']}/apply`)).status).toBe(
      409,
    );
    expect((await consultantA.call('POST', `${base}/proposals/${ids['P3']}/apply`)).status).toBe(
      409,
    );
    const p2 = await consultantB.call('POST', `${base}/proposals/${ids['P2']}/apply`);
    expect(p2.status).toBe(201);
    expect(p2.body.result.rebasedFrom).toBe(h);
    expect(p2.body.result.version).toBe(h + 2);
  });

  it('abandon, puis passage en stale à l’application si la tête a divergé', async () => {
    const h = await head();
    await create('P4', h, relabel(elementIds['Assistante']!, 'Via P4'));
    const discarded = await consultantA.call('POST', `${base}/proposals/${ids['P4']}/discard`);
    expect(discarded.status).toBe(201);
    expect(discarded.body.status).toBe('discarded');
    expect((await consultantA.call('POST', `${base}/proposals/${ids['P4']}/apply`)).status).toBe(
      409,
    );
    expect((await consultantA.call('POST', `${base}/proposals/${ids['P4']}/discard`)).status).toBe(
      409,
    );
    // Chemin « paresseux » : une proposition remise « pending » à la main mais conflictuelle.
    await admin.query(`update change_proposals set status = 'pending' where id = $1`, [ids['P3']]);
    const stale = await consultantA.call('POST', `${base}/proposals/${ids['P3']}/apply`);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE');
    expect(await status('P3')).toBe('stale');
    expect(await head()).toBe(h);
    expect((await consultantA.call('GET', `${base}/proposals/${ids['P1']}`)).body.status).toBe(
      'applied',
    );
    expect((await consultantA.call('GET', `${base}/proposals/${SEED_IDS.client}`)).status).toBe(
      404,
    );
  });
});

describe('WP-08 : cloisonnement', () => {
  it('un consultant non affecté à la mission reçoit 404 sur toutes les routes du modèle', async () => {
    const other = await managerC.call('POST', '/missions', {
      clientId: SEED_IDS.client,
      name: 'Autre mission',
    });
    expect(other.status).toBe(201);
    const id = other.body.mission.id as string;
    expect((await consultantA.call('GET', `/missions/${id}/model`)).status).toBe(404);
    expect((await consultantA.call('GET', `/missions/${id}/model/versions`)).status).toBe(404);
    expect(
      (await consultantA.call('POST', `/missions/${id}/model/rollback`, { toVersion: 1 })).status,
    ).toBe(404);
    // Les versions de la mission seed restent invisibles depuis l'autre mission (RLS).
    const res = await managerC.call('GET', `/missions/${id}/model`);
    expect(res.body.version).toBe(0);
    expect(Object.keys(res.body.model.elements)).toHaveLength(0);
  });
});
