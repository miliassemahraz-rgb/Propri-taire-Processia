import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@processia/config/env';
import { CSRF_HEADER, SESSION_COOKIE } from '@processia/contracts';
import {
  DEV_PASSWORD,
  resetTestDatabase,
  resolveDbUrls,
  SEED_IDS,
  seedDevelopment,
} from '@processia/db';
import { buildCompleteModel, completeness, overallCompleteness } from '@processia/model';
import { generateSync } from 'otplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { decryptSecret } from '../auth/crypto.js';
import { KEY_PURPOSE } from '../clients/ai-config.service.js';
import { ENV } from '../env.js';
import { RATE_LIMIT_OPTIONS } from '../auth/guards.js';

// Intégration : exige `pnpm services:up`. Vraie application Nest sur HTTP, base `processia_test`,
// rôle `processia_app` (soumis à la RLS).

const urls = resolveDbUrls(process.env, { test: true });

let app: INestApplication;
let base: string;
let admin: pg.Pool;
let masterKey: string;

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

class Client {
  cookie: string | undefined;
  csrf: string | undefined;

  async call(method: string, path: string, body?: unknown): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie !== undefined) headers['cookie'] = this.cookie;
    if (this.csrf !== undefined) headers[CSRF_HEADER] = this.csrf;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      if (pair?.startsWith(`${SESSION_COOKIE}=`)) this.cookie = pair;
    }
    const text = await res.text();
    const parsed = text === '' ? {} : JSON.parse(text);
    if (typeof parsed.csrfToken === 'string') this.csrf = parsed.csrfToken;
    return { status: res.status, body: parsed };
  }

  /** Connexion complète (mot de passe, enrôlement TOTP, confirmation). */
  async signIn(email: string): Promise<this> {
    expect((await this.call('POST', '/auth/login', { email, password: DEV_PASSWORD })).status).toBe(
      200,
    );
    const enroll = await this.call('POST', '/auth/mfa/enroll');
    const secret = enroll.body.manualEntryKey as string;
    const confirm = await this.call('POST', '/auth/mfa/confirm', {
      code: generateSync({ secret }),
    });
    expect(confirm.status).toBe(200);
    return this;
  }
}

/**
 * Édition réelle du modèle (WP-08) : un ChangeSet de disposition sur la tête courante.
 * Protégée par `model.edit` : c'est la route qui remplace l'ancienne route de test.
 */
async function edit(client: Client, missionId: string): Promise<Reply> {
  const head = await client.call('GET', `/missions/${missionId}/model`);
  const baseVersion = head.status === 200 ? (head.body.version as number) : 0;
  return client.call('POST', `/missions/${missionId}/model/changes`, {
    changeSet: {
      baseVersion,
      cause: 'layout',
      summary: 'Test de droit',
      ops: [{ op: 'set_layout', diagram: 'L0', positions: {} }],
    },
  });
}

let adminC: Client;
let managerC: Client;
let consultantA: Client;
let consultantB: Client;
let validatorC: Client;
let other: { id: string }; // mission créée par l'administrateur (le responsable n'en est pas membre)

beforeAll(async () => {
  await resetTestDatabase(urls);
  await seedDevelopment(urls.admin);
  admin = new pg.Pool({ connectionString: urls.admin, max: 2 });
  const env = loadEnv({ ...process.env, DATABASE_APP_URL: urls.app });
  masterKey = env.MASTER_KEY;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(RATE_LIMIT_OPTIONS)
    .useValue({ limit: 10_000, windowMs: 60_000 })
    .compile();
  app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  adminC = await new Client().signIn('admin@processia.local');
  managerC = await new Client().signIn('responsable@processia.local');
  consultantA = await new Client().signIn('consultante1@processia.local');
  consultantB = await new Client().signIn('consultant2@processia.local');
  validatorC = await new Client().signIn('validateur@processia.local');
});

afterAll(async () => {
  await app.close();
  await admin.end();
});

const MISSION = SEED_IDS.mission;

describe('WP-06 : droits, missions, affectations', () => {
  it('l’administrateur crée une mission que seuls les responsables et lui voient (PO-22)', async () => {
    const created = await adminC.call('POST', '/missions', {
      clientId: SEED_IDS.client,
      name: 'Mission de l’administrateur',
    });
    expect(created.status).toBe(201);
    other = created.body.mission;
    expect(created.body.mission.myRole).toBeNull();
    expect(created.body.warnings).toEqual([]);

    // 2. Un consultant non affecté reçoit 404 (jamais 403), comme pour une mission inexistante.
    const hidden = await consultantA.call('GET', `/missions/${other.id}`);
    const absent = await consultantA.call('GET', '/missions/00000000-0000-7000-8000-00000000ffff');
    const garbage = await consultantA.call('GET', '/missions/pas-un-uuid');
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(garbage.status).toBe(404);
    expect(hidden.body).toEqual(absent.body);
    expect((await consultantA.call('GET', `/missions/${other.id}/members`)).status).toBe(404);
    expect((await consultantA.call('PUT', `/missions/${other.id}/members`, {})).status).toBe(404);
    // La mission où il est affecté reste visible.
    expect((await consultantA.call('GET', `/missions/${MISSION}`)).status).toBe(200);
    const listA = await consultantA.call('GET', '/missions');
    expect(listA.body.map((m: { id: string }) => m.id)).toEqual([MISSION]);
  });

  it('le validateur ne voit que sa mission, sans avancement ni équipe', async () => {
    const list = await validatorC.call('GET', '/missions');
    expect(list.body.map((m: { id: string }) => m.id)).toEqual([MISSION]);
    expect(list.body[0].myRole).toBe('validator');
    expect(list.body[0].progress).toBeNull();
    expect((await validatorC.call('GET', `/missions/${other.id}`)).status).toBe(404);
    expect((await validatorC.call('GET', `/missions/${MISSION}`)).status).toBe(200);
    // mission.view_progress est refusé au validateur : la mission est visible, l'équipe non.
    expect((await validatorC.call('GET', `/missions/${MISSION}/members`)).status).toBe(403);
    expect(
      (await validatorC.call('POST', '/missions', { clientId: SEED_IDS.client, name: 'x' })).status,
    ).toBe(403);
    expect((await validatorC.call('GET', '/users')).status).toBe(403);
  });

  it('un responsable de mission voit et gère toutes les missions, membre ou non (PO-30)', async () => {
    const list = await managerC.call('GET', '/missions');
    expect(list.status).toBe(200);
    const ids = list.body.map((m: { id: string }) => m.id);
    expect(ids).toContain(MISSION);
    expect(ids).toContain(other.id);
    const seen = list.body.find((m: { id: string }) => m.id === other.id);
    expect(seen.myRole).toBeNull();
    expect(seen.progress).not.toBeNull();
    expect((await managerC.call('GET', `/missions/${other.id}`)).status).toBe(200);
    // Droits complets sur une mission créée par l'administrateur, dont il n'est pas membre.
    const patched = await managerC.call('PATCH', `/missions/${other.id}`, {
      name: 'Renommée',
      phase: 'mapping',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.phase).toBe('mapping');
    expect(
      (
        await managerC.call('PUT', `/missions/${other.id}/members`, {
          userId: SEED_IDS.consultantA,
          missionRole: 'consultant',
        })
      ).status,
    ).toBe(200);
    expect((await edit(managerC, other.id)).status).toBe(201);
    expect(
      (await managerC.call('DELETE', `/missions/${other.id}/members/${SEED_IDS.consultantA}`))
        .status,
    ).toBe(204);
    // Sur la sienne aussi.
    expect((await edit(managerC, MISSION)).status).toBe(201);
    // L'administrateur voit toutes les missions.
    const all = await adminC.call('GET', '/missions');
    expect(all.body.map((m: { id: string }) => m.id).sort()).toEqual([MISSION, other.id].sort());
  });

  it('l’administrateur ne peut pas appeler model.edit ; le validateur non plus', async () => {
    expect((await edit(adminC, MISSION)).status).toBe(403);
    expect((await edit(adminC, other.id)).status).toBe(403);
    expect((await edit(validatorC, MISSION)).status).toBe(403);
    expect((await edit(consultantB, MISSION)).status).toBe(201);
    expect((await edit(consultantA, other.id)).status).toBe(404);
    // Sans session : 401 (la garde de droits ne précède pas celle de session).
    expect((await new Client().call('GET', '/missions')).status).toBe(401);
  });

  it('un responsable affecte et retire des membres ; un seul validateur par mission', async () => {
    // Le responsable crée sa propre mission : il en devient responsable affecté.
    const mine = await managerC.call('POST', '/missions', {
      clientId: SEED_IDS.client,
      name: 'Mission du responsable',
      description: 'Test d’affectation',
    });
    expect(mine.status).toBe(201);
    expect(mine.body.mission.myRole).toBe('manager');
    const id = mine.body.mission.id as string;

    expect((await consultantA.call('GET', `/missions/${id}`)).status).toBe(404);
    const assigned = await managerC.call('PUT', `/missions/${id}/members`, {
      userId: SEED_IDS.consultantA,
      missionRole: 'consultant',
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.map((m: { missionRole: string }) => m.missionRole).sort()).toEqual([
      'consultant',
      'manager',
    ]);
    expect((await consultantA.call('GET', `/missions/${id}`)).status).toBe(200);
    // Un consultant n'affecte pas.
    expect(
      (
        await consultantA.call('PUT', `/missions/${id}/members`, {
          userId: SEED_IDS.consultantB,
          missionRole: 'consultant',
        })
      ).status,
    ).toBe(403);

    // Rôles incompatibles avec le rôle global, ou compte administrateur : refusés.
    const put = (userId: string, missionRole: string) =>
      managerC.call('PUT', `/missions/${id}/members`, { userId, missionRole });
    expect((await put(SEED_IDS.consultantB, 'validator')).status).toBe(409);
    expect((await put(SEED_IDS.validator, 'consultant')).status).toBe(409);
    expect((await put(SEED_IDS.admin, 'consultant')).status).toBe(409);
    expect((await put(SEED_IDS.validator, 'validator')).status).toBe(200);
    // Le validateur affecté la voit, sans droit d'équipe.
    expect((await validatorC.call('GET', `/missions/${id}`)).status).toBe(200);

    // Un second validateur est refusé par la base (index unique) ; on le prouve directement.
    await expect(
      admin.query(
        `insert into mission_members (mission_id, user_id, mission_role) values ($1, $2, 'validator')`,
        [id, SEED_IDS.consultantB],
      ),
    ).rejects.toThrow(/mission_members_one_validator_uq/);

    // Retrait.
    const removed = await managerC.call(
      'DELETE',
      `/missions/${id}/members/${SEED_IDS.consultantA}`,
    );
    expect(removed.status).toBe(204);
    expect((await consultantA.call('GET', `/missions/${id}`)).status).toBe(404);
    expect(
      (await managerC.call('DELETE', `/missions/${id}/members/${SEED_IDS.consultantA}`)).status,
    ).toBe(404);
  });

  it('la liste de suivi donne phase, complétude et soumissions en attente', async () => {
    const before = (await managerC.call('GET', '/missions')).body.find(
      (m: { id: string }) => m.id === MISSION,
    );
    expect(before.progress).toEqual({
      phase: 'analysis',
      completeness: 0, // deux éditions de test (WP-08) ont créé des versions du modèle vide
      pendingSubmissions: 0,
    });

    const patched = await managerC.call('PATCH', `/missions/${MISSION}`, { phase: 'mapping' });
    expect(patched.status).toBe(200);
    expect(patched.body.phase).toBe('mapping');
    expect(
      (await consultantA.call('PATCH', `/missions/${MISSION}`, { phase: 'analysis' })).status,
    ).toBe(403);
    expect(
      (await managerC.call('PATCH', `/missions/${MISSION}`, { phase: 'inconnue' })).status,
    ).toBe(400);

    // Une version du modèle (instantané complet) et une soumission en attente.
    const model = buildCompleteModel();
    const expected = overallCompleteness(completeness(model));
    // Les éditions des tests précédents ont déjà créé des versions : on ajoute la suivante.
    const [{ head_version: head }] = (
      await admin.query(`select head_version from missions where id = $1`, [MISSION])
    ).rows as [{ head_version: number }];
    await admin.query(
      `insert into model_versions (mission_id, version, snapshot, cause) values ($1, $2, $3, 'test')`,
      [MISSION, head + 1, JSON.stringify({ ...model, version: head + 1, missionId: MISSION })],
    );
    await admin.query(`update missions set head_version = $2 where id = $1`, [MISSION, head + 1]);
    await admin.query(
      `insert into validation_submissions (mission_id, kind, round, model_version, submitted_by)
       values ($1, 'analysis_dossier', 1, 1, $2)`,
      [MISSION, SEED_IDS.manager],
    );
    const after = (await consultantB.call('GET', '/missions')).body.find(
      (m: { id: string }) => m.id === MISSION,
    );
    expect(after.progress.phase).toBe('mapping');
    expect(after.progress.pendingSubmissions).toBe(1);
    expect(after.progress.completeness).toBeCloseTo(expected, 10);
    expect(after.progress.completeness).toBeGreaterThan(0);
    // Cloisonnement : la soumission d'une mission n'apparaît pas dans une autre.
    const otherSeen = (await adminC.call('GET', '/missions')).body.find(
      (m: { id: string }) => m.id === other.id,
    );
    expect(otherSeen.progress.pendingSubmissions).toBe(0);
  });

  it('pas de retour à une phase déjà validée par le client (PO-31)', async () => {
    const patch = (phase: string) => managerC.call('PATCH', `/missions/${MISSION}`, { phase });
    // Le dossier d'analyse est validé : analysis est interdit, le reste est permis.
    await admin.query(
      `insert into validation_submissions (mission_id, kind, round, model_version, status, submitted_by)
       values ($1, 'analysis_dossier', 2, 1, 'validated', $2)`,
      [MISSION, SEED_IDS.manager],
    );
    const refused = await patch('analysis');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PHASE_REGRESSION');
    expect((await adminC.call('PATCH', `/missions/${MISSION}`, { phase: 'analysis' })).status).toBe(
      409,
    );
    expect((await patch('transformation')).status).toBe(200);
    expect((await patch('mapping')).status).toBe(200);
    // L'AS-IS est validé : mapping est interdit.
    await admin.query(
      `insert into validation_submissions (mission_id, kind, round, model_version, status, submitted_by)
       values ($1, 'as_is', 1, 1, 'validated', $2)`,
      [MISSION, SEED_IDS.manager],
    );
    expect((await patch('mapping')).status).toBe(409);
    expect((await patch('analysis')).status).toBe(409);
    expect((await patch('transformation')).status).toBe(200);
    expect((await patch('generation')).status).toBe(200);
    // Nom et description restent modifiables sans changer de phase.
    expect(
      (await adminC.call('PATCH', `/missions/${MISSION}`, { description: 'Nouvelle description' }))
        .status,
    ).toBe(200);
    // Une autre mission, sans validation, accepte tout retour en arrière.
    expect(
      (await managerC.call('PATCH', `/missions/${other.id}`, { phase: 'analysis' })).status,
    ).toBe(200);
  });
});

describe('WP-06 : configuration IA par client', () => {
  const SECRET = 'sk-test-0123456789abcdefWXYZ';
  const url = `/clients/${SEED_IDS.client}/ai-config`;

  it('seul l’administrateur configure le fournisseur ; la politique est affichée puis acceptée', async () => {
    expect((await managerC.call('PUT', url, { provider: 'fake' })).status).toBe(403);
    expect((await consultantA.call('GET', url)).status).toBe(403);
    expect((await adminC.call('GET', url)).status).toBe(404);

    const policy = await adminC.call('GET', '/ai-providers/anthropic/data-policy');
    expect(policy.status).toBe(200);
    expect(policy.body.text).toMatch(/Anthropic/);
    expect((await adminC.call('GET', '/ai-providers/fake/data-policy')).body.text).toBeNull();
    expect((await managerC.call('GET', '/ai-providers/anthropic/data-policy')).status).toBe(403);

    // Sans acceptation explicite, un vrai fournisseur est refusé.
    const refused = await adminC.call('PUT', url, { provider: 'anthropic', apiKey: SECRET });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('POLICY_NOT_ACCEPTED');
  });

  it('la clé API est chiffrée en base et jamais renvoyée', async () => {
    const saved = await adminC.call('PUT', url, {
      provider: 'anthropic',
      apiKey: SECRET,
      acceptDataPolicy: true,
      models: { default: 'modele-leger-test', extraction: 'modele-leger-test' },
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(SECRET);
    expect(saved.body.apiKey).toEqual({ configured: true, masked: '••••••••WXYZ' });
    expect(saved.body.policyAcceptedBy).toBe(SEED_IDS.admin);
    expect(saved.body.policyAcceptedAt).not.toBeNull();
    expect(saved.body.monthlyBudgetEur).toBe(150);
    expect(saved.body.warnings).toEqual([]);

    const read = await adminC.call('GET', url);
    expect(JSON.stringify(read.body)).not.toContain(SECRET);
    expect(read.body.apiKey.masked).toBe('••••••••WXYZ');

    const { rows } = await admin.query<{ api_key_enc: string; policy_accepted_by: string }>(
      'select api_key_enc, policy_accepted_by from ai_provider_configs where client_id = $1',
      [SEED_IDS.client],
    );
    expect(rows).toHaveLength(1);
    const stored = rows[0]!;
    expect(stored.api_key_enc).toMatch(/^v1\./);
    expect(stored.api_key_enc).not.toContain(SECRET);
    expect(decryptSecret(stored.api_key_enc, masterKey, KEY_PURPOSE)).toBe(SECRET);
    expect(stored.policy_accepted_by).toBe(SEED_IDS.admin);

    // Mise à jour sans clé ni nouvelle acceptation : la clé et l'acceptation sont conservées.
    const again = await adminC.call('PUT', url, { provider: 'anthropic', monthlyBudgetEur: 80 });
    expect(again.status).toBe(200);
    expect(again.body.apiKey.masked).toBe('••••••••WXYZ');
    expect(again.body.monthlyBudgetEur).toBe(80);
    expect(again.body.policyAcceptedAt).toBe(saved.body.policyAcceptedAt);
    expect(
      (
        await admin.query('select 1 from ai_provider_configs where client_id = $1', [
          SEED_IDS.client,
        ])
      ).rowCount,
    ).toBe(1);
    // Aucune trace de la clé dans le journal d'audit.
    const audit = await admin.query(
      `select payload::text as p from audit_log where action like 'ai_config.%'`,
    );
    expect(audit.rowCount).toBe(2);
    expect(audit.rows.map((r) => r.p).join('')).not.toContain(SECRET);

    // Suppression de la clé.
    const cleared = await adminC.call('PUT', url, { provider: 'anthropic', apiKey: '' });
    expect(cleared.body.apiKey).toEqual({ configured: false, masked: null });
  });

  it('avertit si le fournisseur n’a pas la capacité « documents », y compris à la création de mission', async () => {
    const saved = await adminC.call('PUT', url, {
      provider: 'anthropic',
      capabilities: { text: true, documents: false, audio: false },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.warnings).toEqual([{ code: 'CAPABILITY_MISSING', capability: 'documents' }]);

    const mission = await managerC.call('POST', '/missions', {
      clientId: SEED_IDS.client,
      name: 'Mission avec avertissement',
    });
    expect(mission.status).toBe(201);
    expect(mission.body.warnings).toEqual([
      { code: 'CAPABILITY_MISSING', capability: 'documents' },
    ]);

    // Le fournisseur factice déclare les capacités requises : plus d'avertissement.
    const fake = await adminC.call('PUT', url, {
      provider: 'fake',
      capabilities: { text: true, documents: true, audio: false },
    });
    expect(fake.body.warnings).toEqual([]);
    expect(fake.body.dataPolicyText).toBeNull();
  });
});

describe('WP-06 : administration des utilisateurs et clients', () => {
  it('seul l’administrateur gère les comptes et les clients', async () => {
    const list = await adminC.call('GET', '/users');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(5);
    expect(JSON.stringify(list.body)).not.toMatch(/password|totp_secret|passwordHash/i);
    expect((await managerC.call('GET', '/users')).status).toBe(403);
    expect((await managerC.call('POST', '/clients', { name: 'x' })).status).toBe(403);
    // Un responsable peut lister les clients pour créer une mission ; pas un consultant.
    expect((await managerC.call('GET', '/clients')).status).toBe(200);
    expect((await consultantA.call('GET', '/clients')).status).toBe(403);

    const client = await adminC.call('POST', '/clients', {
      name: 'Nouveau client',
      defaultRetentionMonths: 12,
    });
    expect(client.status).toBe(201);
    const renamed = await adminC.call('PATCH', `/clients/${client.body.id}`, {
      name: 'Client renommé',
    });
    expect(renamed.body.name).toBe('Client renommé');
    expect((await adminC.call('GET', '/clients/pas-un-uuid')).status).toBe(400);
  });

  it('PO-27 : les invitations exigent users.manage ; un compte désactivé perd ses sessions', async () => {
    const invite = { email: 'nouveau@processia.local', globalRole: 'consultant' };
    expect((await managerC.call('POST', '/invitations', invite)).status).toBe(403);
    expect((await adminC.call('POST', '/invitations', invite)).status).toBe(201);

    // L'administrateur ne peut ni se désactiver ni se rétrograder.
    expect(
      (await adminC.call('PATCH', `/users/${SEED_IDS.admin}`, { status: 'disabled' })).status,
    ).toBe(403);
    expect(
      (await adminC.call('PATCH', `/users/${SEED_IDS.admin}`, { globalRole: 'consultant' })).status,
    ).toBe(403);

    const disabled = await adminC.call('PATCH', `/users/${SEED_IDS.consultantB}`, {
      status: 'disabled',
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('disabled');
    expect((await consultantB.call('GET', '/missions')).status).toBe(401);
  });

  it('PO-27 : le responsable invite consultants et validateurs pour ses missions, pas davantage', async () => {
    const inv = (c: Client, body: object) => c.call('POST', '/invitations', body);
    const ok = {
      email: 'invite1@processia.local',
      globalRole: 'consultant',
      missionId: MISSION,
      missionRole: 'consultant',
    };
    expect((await inv(managerC, ok)).status).toBe(201);
    expect(
      (
        await inv(managerC, {
          email: 'invite2@processia.local',
          globalRole: 'client_validator',
          missionId: MISSION,
          missionRole: 'validator',
        })
      ).status,
    ).toBe(201);
    // Hors périmètre : sans mission, rôle global supérieur, rôle de mission incohérent, mission non gérée.
    expect(
      (await inv(managerC, { email: 'x1@processia.local', globalRole: 'consultant' })).status,
    ).toBe(403);
    expect(
      (await inv(managerC, { ...ok, email: 'x2@processia.local', globalRole: 'admin' })).status,
    ).toBe(403);
    expect(
      (await inv(managerC, { ...ok, email: 'x3@processia.local', globalRole: 'mission_manager' }))
        .status,
    ).toBe(403);
    expect(
      (await inv(managerC, { ...ok, email: 'x4@processia.local', missionRole: 'manager' })).status,
    ).toBe(403);
    expect(
      (await inv(managerC, { ...ok, email: 'x5@processia.local', missionId: other.id })).status,
    ).toBe(403);
    // Les autres rôles ne peuvent pas inviter.
    expect((await inv(consultantA, ok)).status).toBe(403);
    expect((await inv(validatorC, ok)).status).toBe(403);
    // L'administrateur invite tout rôle.
    expect(
      (await inv(adminC, { email: 'resp2@processia.local', globalRole: 'mission_manager' })).status,
    ).toBe(201);
  });

  it('PO-26 : l’administrateur déverrouille immédiatement un compte bloqué', async () => {
    const email = 'consultante1@processia.local';
    const attacker = new Client();
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (
        await attacker.call('POST', '/auth/login', { email, password: 'mauvais-mot-de-passe-1' })
      ).status;
    }
    expect(last).toBe(429);
    const locked = await attacker.call('POST', '/auth/login', { email, password: DEV_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');

    expect((await managerC.call('POST', `/users/${SEED_IDS.consultantA}/unlock`)).status).toBe(403);
    const unlocked = await adminC.call('POST', `/users/${SEED_IDS.consultantA}/unlock`);
    expect(unlocked.status).toBe(200);
    const again = await attacker.call('POST', '/auth/login', { email, password: DEV_PASSWORD });
    expect(again.status).toBe(200);
    const audit = await admin.query(
      `select actor_id, target from audit_log where action = 'auth.account_unlocked'`,
    );
    expect(audit.rows).toEqual([
      { actor_id: SEED_IDS.admin, target: `user:${SEED_IDS.consultantA}` },
    ]);
    expect(
      (await adminC.call('POST', `/users/00000000-0000-7000-8000-00000000ffff/unlock`)).status,
    ).toBe(404);
  });
});
