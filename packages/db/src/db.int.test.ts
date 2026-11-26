import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, withMission, withoutMission, type Database } from './client.js';
import { migrateDatabase } from './migrate.js';
import * as s from './schema/index.js';
import { MISSION_SCOPED_TABLES } from './schema/index.js';
import { SEED_IDS, seedDevelopment } from './seed.js';
import { resetTestDatabase, withMissionRollback, withRollback } from './testing.js';
import { resolveDbUrls } from './urls.js';

const urls = resolveDbUrls(process.env, { test: true });

const MISSION_A = randomUUID();
const MISSION_B = randomUUID();
const USER = randomUUID();
const CLIENT = randomUUID();

let admin: Database; // compte d'administration : contourne la RLS, sert à préparer les données
let app: Database; // processia_app : le rôle de l'application, soumis à la RLS

/** Une ligne par table cloisonnée et par mission. */
async function seedMission(missionId: string, label: string): Promise<void> {
  await admin.insert(s.missions).values({ id: missionId, clientId: CLIENT, name: label });
  const version = { missionId, version: 1 };
  await admin.insert(s.modelVersions).values({ ...version, snapshot: { label }, cause: 'test' });
  await admin
    .insert(s.modelVersionElements)
    .values({ ...version, elementId: 'e1', change: 'added' });
  await admin
    .insert(s.changeProposals)
    .values({ missionId, baseVersion: 1, instruction: label, changeSet: {} });
  await admin
    .insert(s.dialogueMessages)
    .values({ missionId, thread: 'analysis', role: 'user', content: label });
  const [source] = await admin
    .insert(s.sources)
    .values({ missionId, kind: 'free_text', title: label })
    .returning({ id: s.sources.id });
  await admin
    .insert(s.sourceChunks)
    .values({ missionId, sourceId: source?.id ?? '', ordinal: 0, text: `texte ${label}` });
  await admin.insert(s.analysisRuns).values({ missionId, kind: 'extraction' });
  await admin.insert(s.questions).values({ missionId, concept: 'c', text: label });
  const [submission] = await admin
    .insert(s.validationSubmissions)
    .values({ missionId, kind: 'analysis_dossier', modelVersion: 1, submittedBy: USER })
    .returning({ id: s.validationSubmissions.id });
  const submissionId = submission?.id ?? '';
  await admin.insert(s.optimisationDecisions).values({
    missionId,
    submissionId,
    optimisationId: 'o1',
    value: 'accepted',
    by: USER,
  });
  await admin
    .insert(s.postValidationNotices)
    .values({ missionId, submissionId, elementId: 'e1', version: 1, summary: label });
  await admin
    .insert(s.comments)
    .values({ missionId, targetKind: 'element', targetId: 'e1', authorId: USER, body: label });
  await admin.insert(s.artifacts).values({
    missionId,
    kind: 'pdf',
    purpose: 'test',
    storageKey: `missions/${missionId}/a`,
    sha256: 'x',
  });
  await admin.insert(s.aiCalls).values({
    missionId,
    clientId: CLIENT,
    pipeline: 'p',
    pipelineVersion: '1',
    provider: 'fake',
    model: 'm',
    inputHash: 'h',
    status: 'ok',
  });
  await admin
    .insert(s.yjsDocuments)
    .values({ name: `mission:${missionId}:workspace`, missionId, state: Buffer.from([1, 2, 3]) });
}

beforeAll(async () => {
  await resetTestDatabase(urls);
  admin = createDb(urls.admin, { max: 2 });
  app = createDb(urls.app, { max: 1 }); // une seule connexion : détecte toute fuite de contexte
  await admin.insert(s.clients).values({ id: CLIENT, name: 'Client test' });
  await admin.insert(s.users).values({
    id: USER,
    email: 'test@processia.local',
    displayName: 'Test',
    globalRole: 'consultant',
  });
  await seedMission(MISSION_A, 'A');
  await seedMission(MISSION_B, 'B');
});

afterAll(async () => {
  await closeDb(admin);
  await closeDb(app);
});

/** Drizzle enveloppe l'erreur PostgreSQL : le message utile est dans `cause`. */
async function expectPgError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e as Error & { cause?: Error },
  );
  expect(error, 'une erreur était attendue').toBeDefined();
  expect(`${error?.message} ${error?.cause?.message ?? ''}`).toMatch(pattern);
}

const count = async (db: Database, table: string): Promise<number> => {
  const res = await db.execute<{ n: string }>(sql.raw(`select count(*) as n from "${table}"`));
  return Number(res.rows[0]?.n);
};

describe('migrations et rôles', () => {
  it('db:migrate est idempotent', async () => {
    const applied = async () =>
      Number(
        (
          await admin.execute<{ n: string }>(
            sql`select count(*) as n from drizzle.__drizzle_migrations`,
          )
        ).rows[0]?.n,
      );
    const before = await applied();
    await migrateDatabase(urls);
    await migrateDatabase(urls);
    expect(await applied()).toBe(before);
    expect(before).toBe(4);
  });

  it("l'application utilise un rôle non propriétaire, sans SUPERUSER ni BYPASSRLS", async () => {
    const role = await app.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owners = await admin.execute<{ n: string }>(
      sql`select count(*) as n from pg_tables where schemaname = 'public' and tableowner = 'processia_app'`,
    );
    expect(Number(owners.rows[0]?.n)).toBe(0);
  });

  it('la liste des tables cloisonnées couvre toutes les tables à colonne mission_id obligatoire', async () => {
    const res = await admin.execute<{ table_name: string; relforcerowsecurity: boolean }>(sql`
      select c.table_name, cl.relforcerowsecurity
      from information_schema.columns c
      join pg_class cl on cl.relname = c.table_name and cl.relnamespace = 'public'::regnamespace
      where c.table_schema = 'public' and c.column_name = 'mission_id'`);
    const withRls = res.rows.filter((r) => r.relforcerowsecurity).map((r) => r.table_name);
    expect([...withRls].sort()).toEqual([...MISSION_SCOPED_TABLES].sort());
    // Les autres tables portant mission_id sont filtrées par l'application (spécification 3.2).
    const others = res.rows.filter((r) => !r.relforcerowsecurity).map((r) => r.table_name);
    expect(others.sort()).toEqual(
      ['audit_log', 'invitations', 'mission_members', 'notifications'].sort(),
    );
  });
});

describe.each([...MISSION_SCOPED_TABLES])('cloisonnement RLS : %s', (table) => {
  it('contient des lignes des deux missions pour l’administrateur (préparation du test)', async () => {
    expect(await count(admin, table)).toBeGreaterThanOrEqual(2);
  });

  it('sans app.mission_id, un SELECT renvoie 0 ligne', async () => {
    expect(await count(app, table)).toBe(0);
    await withoutMission(app, async (tx) => {
      const res = await tx.execute(sql.raw(`select 1 from "${table}"`));
      expect(res.rows).toHaveLength(0);
    });
  });

  it('avec la mission A, aucune ligne de la mission B n’est visible', async () => {
    await withMission(app, MISSION_A, async (tx) => {
      const res = await tx.execute<{ mission_id: string }>(
        sql.raw(`select mission_id from "${table}"`),
      );
      expect(res.rows.length).toBeGreaterThan(0);
      expect(res.rows.every((r) => r.mission_id === MISSION_A)).toBe(true);
    });
  });

  it('avec la mission A, les lignes de la mission B ne sont ni modifiables ni supprimables', async () => {
    await withMissionRollback(app, MISSION_A, async (tx) => {
      const upd = await tx.execute(
        sql.raw(
          `update "${table}" set mission_id = mission_id where mission_id = '${MISSION_B}' returning 1`,
        ),
      );
      expect(upd.rows).toHaveLength(0);
      const del = await tx.execute(
        sql.raw(`delete from "${table}" where mission_id = '${MISSION_B}' returning 1`),
      );
      expect(del.rows).toHaveLength(0);
    });
    expect(await count(admin, table)).toBeGreaterThanOrEqual(2);
  });

  it('avec la mission A, on ne peut pas déplacer une ligne vers la mission B', async () => {
    await expect(
      withMissionRollback(app, MISSION_A, (tx) =>
        tx.execute(sql.raw(`update "${table}" set mission_id = '${MISSION_B}'`)),
      ),
    ).rejects.toThrow();
  });
});

describe('cloisonnement : cas particuliers', () => {
  it("l'insertion d'une ligne d'une autre mission est refusée (WITH CHECK)", async () => {
    await expect(
      withMission(app, MISSION_A, (tx) =>
        tx
          .insert(s.sources)
          .values({ missionId: MISSION_B, kind: 'free_text', title: 'intrusion' }),
      ),
    ).rejects.toThrow();
    const ok = await withMission(app, MISSION_A, async (tx) => {
      await tx
        .insert(s.sources)
        .values({ missionId: MISSION_A, kind: 'free_text', title: 'légitime' });
      return (await tx.select().from(s.sources)).length;
    });
    expect(ok).toBe(2);
    await admin.delete(s.sources).where(sql`${s.sources.title} = 'légitime'`);
  });

  it('le contexte de mission ne fuit pas entre transactions (même connexion)', async () => {
    await withMission(app, MISSION_A, async (tx) => {
      expect((await tx.select().from(s.sources)).length).toBeGreaterThan(0);
    });
    expect(await count(app, 'sources')).toBe(0);
  });

  it('un identifiant de mission invalide est refusé avant tout accès', async () => {
    await expect(withMission(app, "x'; drop table users; --", async () => 1)).rejects.toThrow(
      /invalide/,
    );
  });

  it('ai_calls sans mission : invisible sans contexte explicite', async () => {
    await admin.insert(s.aiCalls).values({
      clientId: CLIENT,
      pipeline: 'client-test',
      pipelineVersion: '1',
      provider: 'fake',
      model: 'm',
      inputHash: 'h',
      status: 'ok',
    });
    expect(await count(app, 'ai_calls')).toBe(0);
    const scoped = await withMission(app, MISSION_A, (tx) => tx.select().from(s.aiCalls));
    expect(scoped.every((r) => r.missionId === MISSION_A)).toBe(true);
    const unscoped = await withoutMission(app, (tx) => tx.select().from(s.aiCalls), {
      aiUnscoped: true,
    });
    expect(unscoped.map((r) => r.pipeline)).toEqual(['client-test']);
  });

  it('les tables non cloisonnées restent lisibles sans contexte', async () => {
    const missions = await withoutMission(app, (tx) => tx.select().from(s.missions));
    expect(missions.map((m) => m.id).sort()).toEqual([MISSION_A, MISSION_B].sort());
  });

  it("le journal d'audit est en ajout seulement", async () => {
    await withoutMission(app, (tx) =>
      tx.insert(s.auditLog).values({ action: 'test', actorId: USER, missionId: MISSION_A }),
    );
    await expectPgError(
      withoutMission(app, (tx) => tx.execute(sql`update audit_log set action = 'x'`)),
      /permission denied/,
    );
    await expectPgError(
      withoutMission(app, (tx) => tx.execute(sql`delete from audit_log`)),
      /permission denied/,
    );
  });
});

describe('affectations', () => {
  const user = (n: number) => ({
    id: randomUUID(),
    email: `u${n}-${randomUUID()}@processia.local`,
    displayName: `U${n}`,
    globalRole: 'client_validator',
  });

  it('un seul validateur par mission', async () => {
    const [v1, v2, v3] = [user(1), user(2), user(3)];
    await admin.insert(s.users).values([v1, v2, v3]);
    await admin
      .insert(s.missionMembers)
      .values({ missionId: MISSION_A, userId: v1.id, missionRole: 'validator' });
    await expectPgError(
      Promise.resolve(
        admin
          .insert(s.missionMembers)
          .values({ missionId: MISSION_A, userId: v2.id, missionRole: 'validator' }),
      ),
      /mission_members_one_validator_uq/,
    );
    // Une autre mission peut avoir son validateur ; la mission A peut avoir plusieurs consultants.
    await admin
      .insert(s.missionMembers)
      .values({ missionId: MISSION_B, userId: v2.id, missionRole: 'validator' });
    await admin
      .insert(s.missionMembers)
      .values({ missionId: MISSION_A, userId: v3.id, missionRole: 'consultant' });
  });

  it("l'unicité s'impose aussi au rôle applicatif", async () => {
    const extra = user(9);
    await admin.insert(s.users).values(extra);
    await expectPgError(
      withoutMission(app, (tx) =>
        tx
          .insert(s.missionMembers)
          .values({ missionId: MISSION_A, userId: extra.id, missionRole: 'validator' }),
      ),
      /mission_members_one_validator_uq/,
    );
  });

  it("une valeur d'énumération inconnue est refusée", async () => {
    await expectPgError(
      Promise.resolve(
        admin
          .insert(s.users)
          .values({ email: 'bad@processia.local', displayName: 'Bad', globalRole: 'root' }),
      ),
      /users_global_role_chk/,
    );
  });
});

describe('seed de développement', () => {
  it('crée les comptes et la mission « Cabinet pilote », de façon idempotente', async () => {
    await seedDevelopment(urls.admin);
    await seedDevelopment(urls.admin);
    const members = await withoutMission(app, (tx) =>
      tx
        .select()
        .from(s.missionMembers)
        .where(sql`${s.missionMembers.missionId} = ${SEED_IDS.mission}`),
    );
    expect(members.map((m) => m.missionRole).sort()).toEqual([
      'consultant',
      'consultant',
      'manager',
      'validator',
    ]);
    const mission = await withoutMission(app, (tx) =>
      tx
        .select()
        .from(s.missions)
        .where(sql`${s.missions.id} = ${SEED_IDS.mission}`),
    );
    expect(mission[0]?.name).toBe('Cabinet pilote');
    const roles = await withoutMission(app, (tx) =>
      tx.select({ r: s.users.globalRole }).from(s.users),
    );
    expect(new Set(roles.map((r) => r.r))).toEqual(
      new Set(['admin', 'mission_manager', 'consultant', 'client_validator']),
    );
  });
});

describe('aides de test', () => {
  it('withRollback annule les écritures', async () => {
    await withRollback(admin, async (tx) => {
      await tx.insert(s.clients).values({ name: 'éphémère' });
    });
    const rows = await admin
      .select()
      .from(s.clients)
      .where(sql`${s.clients.name} = 'éphémère'`);
    expect(rows).toHaveLength(0);
  });
});

describe('volumétrie', () => {
  it('insère et relit un instantané JSONB de 2 Mo en moins de 500 ms', async () => {
    const elements = Array.from({ length: 4000 }, (_, i) => ({
      id: `el-${i}`,
      kind: 'task',
      name: `Tâche numéro ${i}`,
      description: 'x'.repeat(430),
      attributes: { owner: 'rôle', duration: i },
    }));
    const snapshot = { schemaVersion: 1, elements };
    expect(JSON.stringify(snapshot).length).toBeGreaterThan(2 * 1024 * 1024);
    const start = performance.now();
    await withMission(app, MISSION_A, async (tx) => {
      await tx
        .insert(s.modelVersions)
        .values({ missionId: MISSION_A, version: 2, parentVersion: 1, snapshot, cause: 'perf' });
      const [row] = await tx
        .select({ snapshot: s.modelVersions.snapshot })
        .from(s.modelVersions)
        .where(sql`${s.modelVersions.version} = 2`);
      expect((row?.snapshot as typeof snapshot).elements).toHaveLength(4000);
    });
    const elapsed = performance.now() - start;
    console.info(`Instantané JSONB de 2 Mo : insertion + lecture en ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(500);
  });
});
