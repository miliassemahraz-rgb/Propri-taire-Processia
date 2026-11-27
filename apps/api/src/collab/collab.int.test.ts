import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createCollabServer, type CollabServer } from '@processia/collab';
import { loadEnv } from '@processia/config/env';
import {
  COLLAB_TOKEN_AUDIENCE,
  COLLAB_TOKEN_ISSUER,
  MODEL_ELEMENTS_MAP,
  MODEL_META_MAP,
  modelDocName,
  workspaceDocName,
  type CollabStatelessMessage,
  type CollabTokenResponse,
} from '@processia/contracts';
import {
  closeDb,
  createDb,
  resetTestDatabase,
  resolveDbUrls,
  SEED_IDS,
  seedDevelopment,
  type Database,
} from '@processia/db';
import { buildActor, tempId, type ChangeSet, type Element } from '@processia/model';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { AppModule } from '../app.module.js';
import { RATE_LIMIT_OPTIONS } from '../auth/guards.js';
import { ENV } from '../env.js';
import { descriptionTextFromState } from '../sources/yjs-text.js';
import { TestClient } from '../testing/http-client.js';

// Intégration WP-10 : exige `pnpm services:up`. API Nest réelle (HTTP), serveur de coédition réel
// (Hocuspocus + `LISTEN`), clients Yjs Node (`HocuspocusProvider`), base `processia_test`.

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const SECRET = 'x'.repeat(40);

let app: INestApplication;
let baseUrl: string;
let admin: pg.Pool;
let collabDb: Database;
let collab: CollabServer;
let collabUrl: string;
const client = () => new TestClient(() => baseUrl);
let consultantA: TestClient;
let consultantB: TestClient;
let validatorC: TestClient;
let managerC: TestClient;
const providers: { destroy(): void }[] = [];

beforeAll(async () => {
  await resetTestDatabase(urls);
  await seedDevelopment(urls.admin);
  admin = new pg.Pool({ connectionString: urls.admin, max: 2 });
  const env = loadEnv({
    ...process.env,
    DATABASE_APP_URL: urls.app,
    COLLAB_JWT_SECRET: SECRET,
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

  collabDb = createDb(urls.app, { max: 4 });
  collab = createCollabServer({
    port: 0,
    address: '127.0.0.1',
    quiet: true,
    db: collabDb,
    jwtSecret: SECRET,
    listenUrl: urls.app,
    debounceMs: 100,
    maxDebounceMs: 500,
  });
  await collab.listen();
  collabUrl = collab.httpURL.replace('http', 'ws');

  consultantA = await client().signIn('consultante1@processia.local');
  consultantB = await client().signIn('consultant2@processia.local');
  managerC = await client().signIn('responsable@processia.local');
  validatorC = await client().signIn('validateur@processia.local');
});

afterAll(async () => {
  for (const p of providers) p.destroy();
  await collab.destroy();
  await closeDb(collabDb);
  await app.close();
  await admin.end();
});

async function tokenOf(c: TestClient): Promise<string> {
  const res = await c.call('POST', `/missions/${MISSION}/collab-token`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as CollabTokenResponse).token;
}

interface Connected {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  scope: () => string | null;
  messages: CollabStatelessMessage[];
  failed: () => boolean;
  ready: Promise<void>;
}

/** Client Yjs Node connecté à un document. */
function connect(name: string, token: string, url: string = collabUrl): Connected {
  const doc = new Y.Doc();
  const messages: CollabStatelessMessage[] = [];
  let scope: string | null = null;
  let failed = false;
  let resolve!: () => void;
  const ready = new Promise<void>((r) => (resolve = r));
  const socket = new HocuspocusProviderWebsocket({
    url,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document: doc,
    token,
    onAuthenticated: ({ scope: s }) => {
      scope = s;
    },
    onAuthenticationFailed: () => {
      failed = true;
      resolve();
    },
    onSynced: () => resolve(),
    onStateless: ({ payload }) => messages.push(JSON.parse(payload) as CollabStatelessMessage),
  });
  provider.attach();
  providers.push(provider, socket);
  return { doc, provider, scope: () => scope, messages, failed: () => failed, ready };
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Délai dépassé en attendant une condition.');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const textOf = (doc: Y.Doc): string => doc.getXmlFragment('description').toString();

describe('WP-10 : coédition', () => {
  it('1. deux clients : des éditions concurrentes de la description convergent', async () => {
    const tokenA = await tokenOf(consultantA);
    const tokenB = await tokenOf(consultantB);
    const a = connect(workspaceDocName(MISSION), tokenA);
    const b = connect(workspaceDocName(MISSION), tokenB);
    await Promise.all([a.ready, b.ready]);
    expect(a.failed() || b.failed()).toBe(false);
    expect(a.scope()).toBe('read-write');

    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText('Cabinet de comptabilité');
    paragraph.insert(0, [text]);
    a.doc.getXmlFragment('description').insert(0, [paragraph]);
    await until(() => textOf(b.doc).includes('Cabinet'));

    // Édition réellement concurrente : B est déconnecté pendant que A et B écrivent.
    const socketB = b.provider.configuration.websocketProvider;
    socketB.disconnect();
    await until(() => socketB.status !== 'connected');
    const ta = a.doc.getXmlFragment('description').get(0) as Y.XmlElement;
    (ta.get(0) as Y.XmlText).insert(0, 'AAA ');
    const tb = b.doc.getXmlFragment('description').get(0) as Y.XmlElement;
    (tb.get(0) as Y.XmlText).insert((tb.get(0) as Y.XmlText).length, ' BBB');
    (tb.get(0) as Y.XmlText).insert(0, 'ZZZ ');
    expect(textOf(a.doc)).not.toBe(textOf(b.doc));
    await socketB.connect();
    await until(() => textOf(a.doc) === textOf(b.doc) && textOf(a.doc).includes('BBB'));
    const final = textOf(a.doc);
    expect(final).toContain('AAA');
    expect(final).toContain('ZZZ');
    expect(final).toContain('BBB');
    expect(final).toContain('Cabinet de comptabilité');

    // Persistance dans yjs_documents (regroupement de 100 ms en test).
    let state: Uint8Array | undefined;
    await until(() => {
      void admin
        .query('select state from yjs_documents where name = $1', [workspaceDocName(MISSION)])
        .then((r) => {
          state = r.rows[0]?.state;
        });
      return state !== undefined && descriptionTextFromState(state).includes('BBB');
    });
    expect(descriptionTextFromState(state!)).toContain('Cabinet de comptabilité');
  });

  it('2. une écriture client sur le document model est rejetée', async () => {
    const tokenA = await tokenOf(consultantA);
    const tokenB = await tokenOf(consultantB);
    const a = connect(modelDocName(MISSION), tokenA);
    const b = connect(modelDocName(MISSION), tokenB);
    await Promise.all([a.ready, b.ready]);
    expect(a.scope()).toBe('readonly');

    a.doc.getMap(MODEL_ELEMENTS_MAP).set('FORGED', { id: 'FORGED', label: 'pirate' });
    a.doc.getMap(MODEL_META_MAP).set('version', 999);
    await new Promise((r) => setTimeout(r, 600));
    const serverDoc = collab.hocuspocus.documents.get(modelDocName(MISSION));
    expect(serverDoc).toBeDefined();
    expect(serverDoc!.getMap(MODEL_ELEMENTS_MAP).has('FORGED')).toBe(false);
    expect(serverDoc!.getMap(MODEL_META_MAP).get('version')).not.toBe(999);
    expect(b.doc.getMap(MODEL_ELEMENTS_MAP).has('FORGED')).toBe(false);
  });

  it('3. un commit par l’API met à jour le Y.Map et diffuse model.version en moins de 2 s', async () => {
    const tokenA = await tokenOf(consultantA);
    const tokenB = await tokenOf(consultantB);
    const a = connect(modelDocName(MISSION), tokenA);
    const b = connect(modelDocName(MISSION), tokenB);
    await Promise.all([a.ready, b.ready]);
    expect(a.doc.getMap(MODEL_ELEMENTS_MAP).size).toBe(0);

    const op = (n: number, label: string): ChangeSet['ops'][number] => ({
      op: 'add',
      element: buildActor({ id: tempId(n), code: `ACT-0${n}`, label }) as Element,
    });
    const base: ChangeSet = {
      baseVersion: 0,
      ops: [op(1, 'Comptable'), op(2, 'Client')],
      cause: 'dialogue_edit',
      summary: 'Deux acteurs',
    };
    const t0 = Date.now();
    const res = await consultantA.call('POST', `/missions/${MISSION}/model/changes`, {
      changeSet: base,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const seen = (c: Connected) =>
      c.messages.some((m) => m.type === 'model.version' && m.version === 1) &&
      c.doc.getMap(MODEL_ELEMENTS_MAP).size === 2;
    await until(() => seen(a) && seen(b), 2000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(b.doc.getMap(MODEL_META_MAP).get('version')).toBe(1);

    // Version 2 : un seul élément modifié, un seul retiré.
    const ids = [...b.doc.getMap<Element>(MODEL_ELEMENTS_MAP).keys()];
    const first = b.doc.getMap<Element>(MODEL_ELEMENTS_MAP).get(ids[0]!)!;
    const second = ids[1]!;
    const changed: string[] = [];
    b.doc.getMap(MODEL_ELEMENTS_MAP).observe((e) => {
      for (const key of e.keysChanged) changed.push(key);
    });
    const res2 = await consultantB.call('POST', `/missions/${MISSION}/model/changes`, {
      changeSet: {
        baseVersion: 1,
        ops: [
          { op: 'update', id: first.id, set: { label: 'Comptable principal' } },
          { op: 'remove', id: second },
        ],
        cause: 'dialogue_edit',
        summary: 'Edition',
      } satisfies ChangeSet,
    });
    expect(res2.status, JSON.stringify(res2.body)).toBe(201);
    await until(() => b.messages.some((m) => m.type === 'model.version' && m.version === 2), 2000);
    expect(new Set(changed)).toEqual(new Set([first.id, second]));
    expect(b.doc.getMap<Element>(MODEL_ELEMENTS_MAP).get(first.id)?.label).toBe(
      'Comptable principal',
    );
    expect(b.doc.getMap(MODEL_ELEMENTS_MAP).has(second)).toBe(false);

    // Un client qui se connecte après coup voit la tête (document reconstruit depuis la base).
    const late = connect(modelDocName(MISSION), await tokenOf(managerC));
    await late.ready;
    expect(late.doc.getMap(MODEL_ELEMENTS_MAP).size).toBe(1);
    expect(late.doc.getMap(MODEL_META_MAP).get('version')).toBe(2);
  });

  it('3 bis. run.progress de mission_messages est relayé par message sans état', async () => {
    const a = connect(modelDocName(MISSION), await tokenOf(consultantA));
    await a.ready;
    const message = {
      type: 'run.progress',
      missionId: MISSION,
      runId: 'r1',
      kind: 'extraction',
      status: 'running',
      progress: 40,
      sourceId: null,
      error: null,
    };
    await admin.query(`select pg_notify('mission_messages', $1)`, [JSON.stringify(message)]);
    await until(() => a.messages.some((m) => m.type === 'run.progress'));
    expect(a.messages.find((m) => m.type === 'run.progress')).toMatchObject({ progress: 40 });
  });

  it('4. jeton expiré ou utilisateur non membre : refusé', async () => {
    const forge = (sub: string, exp: number | string, secret = SECRET) =>
      new SignJWT({ mid: MISSION })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuer(COLLAB_TOKEN_ISSUER)
        .setAudience(COLLAB_TOKEN_AUDIENCE)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
        .setExpirationTime(exp)
        .sign(new TextEncoder().encode(secret));

    const expired = connect(
      workspaceDocName(MISSION),
      await forge(SEED_IDS.consultantA, Math.floor(Date.now() / 1000) - 60),
    );
    await expired.ready;
    expect(expired.failed()).toBe(true);

    const badSignature = connect(
      workspaceDocName(MISSION),
      await forge(SEED_IDS.consultantA, '10m', 'y'.repeat(40)),
    );
    await badSignature.ready;
    expect(badSignature.failed()).toBe(true);

    // Jeton valide, mais le compte a été retiré de la mission depuis : revérification en base.
    const tokenB = await tokenOf(consultantB);
    await admin.query('delete from mission_members where mission_id = $1 and user_id = $2', [
      MISSION,
      SEED_IDS.consultantB,
    ]);
    try {
      const removed = connect(workspaceDocName(MISSION), tokenB);
      await removed.ready;
      expect(removed.failed()).toBe(true);
      const api = await consultantB.call('POST', `/missions/${MISSION}/collab-token`, {});
      expect(api.status).toBe(404);
    } finally {
      await admin.query(
        `insert into mission_members (mission_id, user_id, mission_role) values ($1, $2, 'consultant')`,
        [MISSION, SEED_IDS.consultantB],
      );
    }

    // Jeton d'une autre mission pour ce document.
    const otherMission = await new SignJWT({ mid: '00000000-0000-7000-8000-0000000000ff' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(SEED_IDS.consultantA)
      .setIssuer(COLLAB_TOKEN_ISSUER)
      .setAudience(COLLAB_TOKEN_AUDIENCE)
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(SECRET));
    const wrong = connect(workspaceDocName(MISSION), otherMission);
    await wrong.ready;
    expect(wrong.failed()).toBe(true);
  });

  it('5. le validateur ne peut pas se connecter au document workspace', async () => {
    const api = await validatorC.call('POST', `/missions/${MISSION}/collab-token`, {});
    expect(api.status).toBe(403);
    // Même avec un jeton correctement signé à son nom, le serveur refuse.
    const forged = await new SignJWT({ mid: MISSION })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(SEED_IDS.validator)
      .setIssuer(COLLAB_TOKEN_ISSUER)
      .setAudience(COLLAB_TOKEN_AUDIENCE)
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(SECRET));
    for (const name of [workspaceDocName(MISSION), modelDocName(MISSION)]) {
      const v = connect(name, forged);
      await v.ready;
      expect(v.failed(), name).toBe(true);
    }
  });

  it('6. workspace.flush écrit le texte en base sans attendre le regroupement et accuse réception', async () => {
    // Serveur au regroupement très long : seule la demande explicite peut écrire dans le délai du test.
    const slow = createCollabServer({
      port: 0,
      address: '127.0.0.1',
      quiet: true,
      db: collabDb,
      jwtSecret: SECRET,
      debounceMs: 60_000,
      maxDebounceMs: 120_000,
    });
    await slow.listen();
    try {
      const url = slow.httpURL.replace('http', 'ws');
      const a = connect(workspaceDocName(MISSION), await tokenOf(consultantA), url);
      await a.ready;
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Texte à enregistrer tout de suite FLUSH-WP13')]);
      a.doc.getXmlFragment('description').insert(0, [paragraph]);

      const stored = async (): Promise<string> => {
        const r = await admin.query('select state from yjs_documents where name = $1', [
          workspaceDocName(MISSION),
        ]);
        return r.rows[0] === undefined ? '' : descriptionTextFromState(r.rows[0].state);
      };
      expect(await stored()).not.toContain('FLUSH-WP13');

      const flushed: unknown[] = [];
      a.provider.on('stateless', ({ payload }: { payload: string }) =>
        flushed.push(JSON.parse(payload)),
      );
      a.provider.sendStateless(JSON.stringify({ type: 'workspace.flush', id: 'abc' }));
      await until(() => flushed.length > 0);
      expect(flushed[0]).toEqual({ type: 'workspace.flushed', id: 'abc' });
      expect(await stored()).toContain('FLUSH-WP13');
    } finally {
      await slow.destroy();
    }
  });
});
