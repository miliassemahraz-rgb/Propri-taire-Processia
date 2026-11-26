import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@processia/config/env';
import {
  MAX_UPLOAD_BYTES,
  MISSION_MESSAGES_CHANNEL,
  type ChunkDto,
  type RunProgressMessage,
  type SourceDto,
} from '@processia/contracts';
import { resetTestDatabase, resolveDbUrls, SEED_IDS, seedDevelopment } from '@processia/db';
import {
  buildDocx,
  buildPdf,
  buildPng,
  buildScannedPdf,
  buildXlsx,
} from '@processia/test-fixtures';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiProviderRegistry } from '../ai/ai-provider.registry.js';
import { AppModule } from '../app.module.js';
import { RATE_LIMIT_OPTIONS } from '../auth/guards.js';
import { ENV } from '../env.js';
import { JobsService } from '../jobs/jobs.service.js';
import { StorageService } from '../storage/storage.service.js';
import { TestClient, type Reply } from '../testing/http-client.js';

// Intégration WP-11 : exige `pnpm services:up` (PostgreSQL et MinIO). Application Nest réelle sur
// HTTP, worker pg-boss dans le même processus, fournisseur IA factice.

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const base = `/missions/${MISSION}`;

let app: INestApplication;
let baseUrl: string;
let admin: pg.Pool;
let consultantA: TestClient;
let consultantB: TestClient;
let validatorC: TestClient;
let listener: pg.Client;
const progress: RunProgressMessage[] = [];
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
  validatorC = await client().signIn('validateur@processia.local');
  listener = new pg.Client({ connectionString: urls.admin });
  await listener.connect();
  await listener.query(`LISTEN ${MISSION_MESSAGES_CHANNEL}`);
  listener.on('notification', (n) => {
    if (n.channel === MISSION_MESSAGES_CHANNEL && n.payload) progress.push(JSON.parse(n.payload));
  });
}, 60_000);

afterAll(async () => {
  await listener.end();
  await app.close();
  await admin.end();
});

async function upload(name: string, content: Uint8Array, who: TestClient = consultantA) {
  return who.upload(`${base}/sources/documents`, name, content);
}

/** Attend la fin de l'extraction (le worker tourne dans le processus de test). */
async function settle(sourceId: string): Promise<SourceDto> {
  for (let i = 0; i < 100; i += 1) {
    const res = await consultantA.call('GET', `${base}/sources/${sourceId}`);
    if (res.status === 200 && res.body.textStatus !== 'pending') return res.body as SourceDto;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Extraction non terminée.');
}

async function chunksOf(sourceId: string): Promise<ChunkDto[]> {
  const res = await consultantA.call('GET', `${base}/sources/${sourceId}/chunks`);
  expect(res.status).toBe(200);
  return res.body as ChunkDto[];
}

async function uploadAndSettle(name: string, content: Uint8Array) {
  const res = await upload(name, content);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...res.body, settled: await settle(res.body.source.id) } as {
    source: SourceDto;
    runId: string;
    settled: SourceDto;
  };
}

describe('WP-11 : sources', () => {
  it('1. PDF, DOCX, XLSX et image donnent des morceaux avec des localisateurs corrects', async () => {
    // Fournisseur doté de « documents » pour l'image : déclaré par l'administrateur du client.
    await admin.query(
      `insert into ai_provider_configs (client_id, provider, models, capabilities, active)
       values ($1, 'fake', '{"default":"modele-factice"}', '{"text":true,"documents":true,"audio":false}', true)`,
      [SEED_IDS.client],
    );
    app.get(AiProviderRegistry).registerFakeScenario('extraction.document_visual', () => ({
      pages: [{ page: 1, text: 'Tableau affiché au mur : le cabinet ouvre à 8 h 30.' }],
    }));

    const pdf = await uploadAndSettle(
      'dossier.pdf',
      buildPdf([
        ['Le cabinet reçoit les dossiers clients chaque matin.'],
        ['La comptable saisit les écritures dans le logiciel.'],
      ]),
    );
    expect(pdf.settled.textStatus).toBe('extracted');
    expect(pdf.settled.mime).toBe('application/pdf');
    expect(pdf.settled.sha256).toMatch(/^[0-9a-f]{64}$/);
    const pdfChunks = await chunksOf(pdf.source.id);
    expect(pdfChunks).toHaveLength(1);
    expect(pdfChunks[0]?.locator).toEqual({ kind: 'page', pageStart: 1, pageEnd: 2 });
    expect(pdfChunks[0]?.text).toContain('saisit les écritures');

    const docx = await uploadAndSettle(
      'presentation.docx',
      await buildDocx([
        { text: 'Organisation', heading: 1 },
        { text: 'Douze salariés répartis sur trois métiers.' },
        { text: 'Relances', heading: 2 },
        { text: 'Les pièces manquantes sont relancées par courriel.' },
      ]),
    );
    expect(docx.settled.textStatus).toBe('extracted');
    const docxChunks = await chunksOf(docx.source.id);
    expect(docxChunks[0]?.locator).toEqual({
      kind: 'paragraph',
      paragraphStart: 1,
      paragraphEnd: 4,
      heading: 'Organisation',
    });
    expect(docxChunks[0]?.text).toContain('relancées par courriel');

    const xlsx = await uploadAndSettle(
      'acteurs.xlsx',
      await buildXlsx([
        {
          name: 'Acteurs',
          rows: [
            ['Acteur', 'Rôle'],
            ['Comptable', 'Saisie'],
            ['Associé', 'Validation'],
          ],
        },
        { name: 'Outils', rows: [['Outil'], ['Excel']] },
      ]),
    );
    expect(xlsx.settled.textStatus).toBe('extracted');
    const xlsxChunks = await chunksOf(xlsx.source.id);
    expect(xlsxChunks.map((c) => c.locator)).toEqual([
      { kind: 'cell', sheet: 'Acteurs', range: 'A1:B3', rowStart: 1, rowEnd: 3 },
      { kind: 'cell', sheet: 'Outils', range: 'A1:A2', rowStart: 1, rowEnd: 2 },
    ]);
    expect(xlsxChunks[0]?.text).toContain('Acteur : Comptable | Rôle : Saisie');

    const image = await uploadAndSettle('affiche.png', buildPng());
    expect(image.settled.textStatus).toBe('extracted');
    const imageChunks = await chunksOf(image.source.id);
    expect(imageChunks[0]?.locator).toEqual({ kind: 'page', pageStart: 1, pageEnd: 1 });
    expect(imageChunks[0]?.text).toContain('le cabinet ouvre à 8 h 30');

    // Les appels IA de l'extraction visuelle sont journalisés, pièce jointe réduite à ses métadonnées.
    const calls = await admin.query(
      `select pipeline, status from ai_calls where mission_id = $1 and pipeline = 'extraction.document_visual'`,
      [MISSION],
    );
    expect(calls.rows).toEqual([{ pipeline: 'extraction.document_visual', status: 'ok' }]);

    // run.progress : files d'attente, exécution, succès, progression croissante par exécution.
    await new Promise((r) => setTimeout(r, 300));
    const forRun = progress.filter((m) => m.runId === pdf.runId);
    expect(forRun.map((m) => m.status)).toContain('queued');
    expect(forRun.map((m) => m.status)).toContain('running');
    expect(forRun.at(-1)).toMatchObject({
      type: 'run.progress',
      missionId: MISSION,
      sourceId: pdf.source.id,
      status: 'succeeded',
      progress: 100,
    });
    const values = forRun.map((m) => m.progress);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    const run = await consultantA.call('GET', `${base}/runs/${pdf.runId}`);
    expect(run.body).toMatchObject({ status: 'succeeded', progress: 100, error: null });
  });

  it('2. un PDF image (ou une image) sans fournisseur doté de « documents » est « non lisible », signalé', async () => {
    await admin.query(`delete from ai_provider_configs where client_id = $1`, [SEED_IDS.client]);
    const scanned = await uploadAndSettle('scan.pdf', buildScannedPdf(2));
    expect(scanned.settled.textStatus).toBe('unreadable');
    expect(await chunksOf(scanned.source.id)).toEqual([]);
    const run = await consultantA.call('GET', `${base}/runs/${scanned.runId}`);
    expect(run.body).toMatchObject({ status: 'failed', error: 'SOURCE_UNREADABLE' });
    const note = await admin.query(
      `select kind, payload from notifications where mission_id = $1 and kind = 'source.unreadable'`,
      [MISSION],
    );
    expect(note.rows).toHaveLength(1);
    expect(note.rows[0]?.payload).toMatchObject({ sourceId: scanned.source.id, title: 'scan.pdf' });
    const image = await uploadAndSettle('photo.png', buildPng());
    expect(image.settled.textStatus).toBe('unreadable');

    // Fournisseur actif mais sans la capacité « documents » : même résultat.
    await admin.query(
      `insert into ai_provider_configs (client_id, provider, models, capabilities, active)
       values ($1, 'fake', '{"default":"modele-factice"}', '{"text":true,"documents":false,"audio":false}', true)`,
      [SEED_IDS.client],
    );
    const again = await uploadAndSettle('scan2.pdf', buildScannedPdf(1));
    expect(again.settled.textStatus).toBe('unreadable');
    await admin.query(`delete from ai_provider_configs where client_id = $1`, [SEED_IDS.client]);
  });

  it('3. un fichier de plus de 50 Mo ou un type falsifié est refusé', async () => {
    const before = await admin.query(`select count(*)::int as n from sources`);
    const header = Buffer.from('%PDF-1.4\n');

    const justOver = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x20);
    header.copy(justOver);
    const tooBig = await upload('gros.pdf', justOver);
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.code).toBe('FILE_TOO_LARGE');

    const wayOver = Buffer.alloc(MAX_UPLOAD_BYTES + 4096, 0x20);
    header.copy(wayOver);
    expect((await upload('enorme.pdf', wayOver)).status).toBe(413);

    // Type falsifié : une image déguisée en PDF, du texte déguisé en PDF, un exécutable en DOCX.
    const forgedPng = await upload('facture.pdf', buildPng());
    expect(forgedPng.status).toBe(415);
    expect(forgedPng.body.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect((await upload('notes.pdf', Buffer.from('juste du texte'))).status).toBe(415);
    expect(
      (await upload('outil.docx', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00]))).status,
    ).toBe(415);
    expect((await upload('script.exe', Buffer.from('MZ'))).status).toBe(415);

    // Exactement 50 Mo de texte reste admis (la limite est inclusive) ; rien d'autre n'est écrit.
    const exact = Buffer.alloc(MAX_UPLOAD_BYTES, 0x61);
    const ok = await upload('limite.txt', exact);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const after = await admin.query(`select count(*)::int as n from sources`);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    await settle(ok.body.source.id);
  }, 120_000);

  it('4. une seconde soumission de la même description crée la révision 2 ; la révision 1 reste lisible', async () => {
    const empty = await consultantA.call('POST', `${base}/sources/description`);
    expect(empty.status).toBe(400);

    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('description');
    const paragraph = (text: string) => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText(text)]);
      return p;
    };
    fragment.insert(0, [
      paragraph('Le cabinet comptable compte douze salariés.'),
      paragraph('Il traite la tenue, la paie et le conseil.'),
    ]);
    const saveDoc = async () => {
      await admin.query(
        `insert into yjs_documents (name, mission_id, state) values ($1, $2, $3)
         on conflict (name) do update set state = excluded.state, updated_at = now()`,
        [`mission:${MISSION}:workspace`, MISSION, Buffer.from(Y.encodeStateAsUpdate(doc))],
      );
    };
    await saveDoc();

    const first = await consultantA.call('POST', `${base}/sources/description`);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ kind: 'free_text', revision: 1, textStatus: 'extracted' });
    const second = await consultantA.call('POST', `${base}/sources/description`);
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ kind: 'free_text', revision: 2 });
    expect(second.body.id).not.toBe(first.body.id);

    // Le texte vivant évolue : la révision 3 change, les révisions 1 et 2 sont immuables.
    fragment.insert(2, [paragraph('Un nouveau service de conseil RH est lancé.')]);
    await saveDoc();
    const third = await consultantA.call('POST', `${base}/sources/description`);
    expect(third.body.revision).toBe(3);

    const rev1 = await chunksOf(first.body.id);
    const rev3 = await chunksOf(third.body.id);
    expect(rev1).toHaveLength(1);
    expect(rev1[0]?.text).toBe(
      'Le cabinet comptable compte douze salariés.\n\nIl traite la tenue, la paie et le conseil.',
    );
    expect(rev1[0]?.locator).toEqual({ kind: 'paragraph', paragraphStart: 1, paragraphEnd: 2 });
    expect(rev3[0]?.text).toContain('conseil RH');
    expect((await chunksOf(second.body.id))[0]?.text).toBe(rev1[0]?.text);
    expect(first.body.sha256).toBe(second.body.sha256);
    expect(third.body.sha256).not.toBe(first.body.sha256);

    const list = (await consultantA.call('GET', `${base}/sources`)).body as SourceDto[];
    const revisions = list.filter((s) => s.kind === 'free_text').map((s) => s.revision);
    expect(revisions.sort()).toEqual([1, 2, 3]);
  });

  it('5. l’URL présignée expire en 5 minutes et n’est délivrée qu’après la garde', async () => {
    const stored = await uploadAndSettle('contrat.pdf', buildPdf([['Contrat de prestation.']]));
    const id = stored.source.id;
    const path = `${base}/sources/${id}/download-url`;

    // La garde : sans session 401, hors mission 404, validateur 403 ; aucune URL n'est délivrée.
    const anonymous = await client().call('GET', path);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.url).toBeUndefined();
    // Le consultant B est retiré de la mission (conservé hors mission pour le test suivant).
    await admin.query(`delete from mission_members where user_id = $1`, [SEED_IDS.consultantB]);
    const outsider = await consultantB.call('GET', path);
    expect(outsider.status).toBe(404);
    expect(outsider.body.url).toBeUndefined();
    const validator = await validatorC.call('GET', path);
    expect(validator.status).toBe(403);
    expect(validator.body.url).toBeUndefined();

    const res: Reply = await consultantA.call('GET', path);
    expect(res.status).toBe(200);
    expect(res.body.expiresInSeconds).toBe(300);
    const url = new URL(res.body.url as string);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.pathname).toContain(`/missions/${MISSION}/sources/${id}/`);
    const file = await fetch(url);
    expect(file.status).toBe(200);
    expect(
      Buffer.from(await file.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');

    // Mécanisme d'expiration : une URL de 1 s cesse de fonctionner.
    const key = (await admin.query(`select storage_key from sources where id = $1`, [id])).rows[0]
      .storage_key as string;
    const shortLived = await app.get(StorageService).presignSourceDownload(key, 'a.pdf', 1);
    expect((await fetch(shortLived)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await fetch(shortLived)).status).toBe(403);

    // Un texte figé n'a pas de fichier.
    const text = (await consultantA.call('GET', `${base}/sources`)).body as SourceDto[];
    const free = text.find((s) => s.kind === 'free_text');
    expect((await consultantA.call('GET', `${base}/sources/${free?.id}/download-url`)).status).toBe(
      404,
    );
  }, 30_000);

  it('6. visionneuse : un morceau avec le passage surligné par charStart et charEnd', async () => {
    const stored = await uploadAndSettle('vue.pdf', buildPdf([['Alpha beta gamma delta.']]));
    const id = stored.source.id;
    const chunk = (await chunksOf(id))[0] as ChunkDto;
    const start = chunk.text.indexOf('beta');
    const res = await consultantA.call(
      'GET',
      `${base}/sources/${id}/chunks/0?charStart=${start}&charEnd=${start + 4}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.highlight).toEqual({
      charStart: start,
      charEnd: start + 4,
      before: 'Alpha ',
      match: 'beta',
      after: ' gamma delta.',
    });
    expect(res.body).toMatchObject({ previousOrdinal: null, nextOrdinal: null });
    expect(res.body.chunk.locator).toEqual({ kind: 'page', pageStart: 1, pageEnd: 1 });
    expect(
      (await consultantA.call('GET', `${base}/sources/${id}/chunks/0`)).body.highlight,
    ).toBeNull();
    expect(
      (await consultantA.call('GET', `${base}/sources/${id}/chunks/0?charStart=5&charEnd=2`))
        .status,
    ).toBe(400);
    expect(
      (await consultantA.call('GET', `${base}/sources/${id}/chunks/0?charStart=0&charEnd=9999`))
        .status,
    ).toBe(400);
    expect((await consultantA.call('GET', `${base}/sources/${id}/chunks/7`)).status).toBe(404);
  });

  it('7. cloisonnement et droits : dépôt réservé à qui peut modifier, lecture sous RLS', async () => {
    expect((await upload('x.txt', Buffer.from('texte'), validatorC)).status).toBe(403);
    expect((await upload('x.txt', Buffer.from('texte'), consultantB)).status).toBe(404);
    expect((await consultantB.call('GET', `${base}/sources`)).status).toBe(404);
    // Sans contexte de mission, le rôle applicatif ne voit aucune source ni aucun morceau.
    const app_ = new pg.Pool({ connectionString: urls.app, max: 1 });
    expect((await app_.query(`select count(*)::int as n from sources`)).rows[0].n).toBe(0);
    expect((await app_.query(`select count(*)::int as n from source_chunks`)).rows[0].n).toBe(0);
    await app_.end();
  });
});
