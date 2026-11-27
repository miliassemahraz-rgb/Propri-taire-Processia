import { mkdirSync, writeFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@processia/config/env';
import type {
  DeliverablesPreviewDto,
  ExportArtifactDto,
  ExportFormat,
  PresignedUrlDto,
  RunDto,
  StartExportResult,
} from '@processia/contracts';
import { resetTestDatabase, resolveDbUrls, SEED_IDS, seedDevelopment } from '@processia/db';
import { documentTables, sha256Hex } from '@processia/exports';
import { messages } from '@processia/i18n';
import type { BusinessModel, Element } from '@processia/model';
import {
  PILOT_DESCRIPTION,
  PILOT_HYPOTHESES,
  pilotDeliverablesChangeSet,
} from '@processia/test-fixtures';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import pg from 'pg';
import { extractText, getDocumentProxy } from 'unpdf';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { RATE_LIMIT_OPTIONS } from '../auth/guards.js';
import { ENV } from '../env.js';
import { JobsService } from '../jobs/jobs.service.js';
import { TestClient } from '../testing/http-client.js';

// Intégration WP-15 : exige `pnpm services:up` (PostgreSQL, MinIO) et un Chromium pour le PDF
// (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH). Application Nest réelle sur HTTP, worker pg-boss dans le
// même processus, fournisseur IA factice rejouant le scénario du pilote.
// `WP15_SAMPLES_DIR=<dossier>` écrit un exemplaire de chaque format (échantillons pour le PO).

const urls = resolveDbUrls(process.env, { test: true });
const MISSION = SEED_IDS.mission;
const base = `/missions/${MISSION}`;
const NOW = '2026-11-27T09:00:00.000Z';

let app: INestApplication;
let baseUrl: string;
let admin: pg.Pool;
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

async function waitRun(runId: string, who: TestClient = consultantA): Promise<RunDto> {
  for (let i = 0; i < 600; i += 1) {
    const res = await who.call('GET', `${base}/runs/${runId}`);
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

async function run(path: string): Promise<RunDto> {
  const res = await consultantA.call('POST', `${base}/${path}`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const done = await waitRun((res.body as { runId: string }).runId);
  expect(done, JSON.stringify(done)).toMatchObject({ status: 'succeeded' });
  return done;
}

const accept = async (id: string) => {
  const res = await consultantA.call('POST', `${base}/elements/${id}/decision`, {
    decision: 'accept',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};

/** Lance un export et attend l'artefact ; retourne l'artefact et ses octets (URL présignée). */
async function exportAs(
  format: ExportFormat,
): Promise<{ start: StartExportResult; artifact: ExportArtifactDto; bytes: Buffer }> {
  const started = await consultantA.call('POST', `${base}/exports`, { format });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const start = started.body as StartExportResult;
  const done = await waitRun(start.runId);
  expect(done, JSON.stringify(done)).toMatchObject({ kind: 'export', status: 'succeeded' });
  expect(done.resultVersion).toBe(start.modelVersion);
  const artifacts = (await consultantA.call('GET', `${base}/exports`)).body as ExportArtifactDto[];
  const artifact = artifacts.find(
    (a) => a.format === format && a.modelVersion === start.modelVersion,
  );
  if (artifact === undefined) throw new Error('Artefact absent de la liste.');
  const url = (await consultantA.call('GET', `${base}/exports/${artifact.id}/download-url`))
    .body as PresignedUrlDto;
  const file = await fetch(url.url);
  expect(file.status).toBe(200);
  return { start, artifact, bytes: Buffer.from(await file.arrayBuffer()) };
}

/** Éléments confirmés par le consultant (saisie directe) : données, flux, règles, RACI. */
async function enrichModel(): Promise<void> {
  const { version, model } = await head();
  const res = await consultantA.call('POST', `${base}/model/changes`, {
    changeSet: pilotDeliverablesChangeSet({
      baseVersion: version,
      userId: SEED_IDS.consultantA,
      at: NOW,
      idOf: (label) => byLabel(model, label).id,
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

let hypothesisLabels: string[] = [];
let confirmedHypothesisLabels: string[] = [];

describe('WP-15 : livrables et exports du dossier d’analyse', () => {
  it('prépare le pilote : analyse, hypothèses confirmées en partie, synthèse confirmée, saisies', async () => {
    await setDescription(PILOT_DESCRIPTION);
    const res = await consultantA.call('POST', `${base}/analysis/extractions`, {});
    expect(res.status).toBe(201);
    expect((await waitRun(res.body.runId)).status).toBe('succeeded');
    await run('hypotheses/generate');
    const { model } = await head();
    hypothesisLabels = PILOT_HYPOTHESES.map((h) => h.proposal.label);
    for (const label of hypothesisLabels) {
      expect(byLabel(model, label).status.value).toBe('hypothesis');
    }
    // Confirmées : le terme du glossaire et l'outil. Les trois autres restent des hypothèses.
    confirmedHypothesisLabels = ['Liasse fiscale', 'Logiciel de GED'];
    for (const label of confirmedHypothesisLabels) await accept(byLabel(model, label).id);
    await run('summary/generate');
    const summary = list((await head()).model).find(
      (e) => e.kind === 'business_trait' && e.facet === 'summary',
    );
    expect(summary?.status.value).toBe('hypothesis');
    await accept(summary?.id ?? '');
    await enrichModel();
    const after = (await head()).model;
    expect(list(after).filter((e) => e.status.value === 'hypothesis')).toHaveLength(3);
  });

  it('droits : le validateur n’a accès ni à l’aperçu, ni à la liste, ni aux exports', async () => {
    expect((await validator.call('GET', `${base}/deliverables`)).status).toBe(403);
    expect((await validator.call('GET', `${base}/exports`)).status).toBe(403);
    expect((await validator.call('POST', `${base}/exports`, { format: 'docx' })).status).toBe(403);
    expect(
      (
        await validator.call(
          'GET',
          `${base}/exports/00000000-0000-7000-8000-00000000ffff/download-url`,
        )
      ).status,
    ).toBe(403);
  });

  it('format inconnu : 400 ; artefact inconnu : 404', async () => {
    expect((await consultantA.call('POST', `${base}/exports`, { format: 'pptx' })).status).toBe(
      400,
    );
    expect(
      (
        await consultantA.call(
          'GET',
          `${base}/exports/00000000-0000-7000-8000-00000000ffff/download-url`,
        )
      ).status,
    ).toBe(404);
  });

  it('aperçu : les 4 livrables du pilote, sans hypothèse non confirmée', async () => {
    const res = await consultantA.call('GET', `${base}/deliverables`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const preview = res.body as DeliverablesPreviewDto;
    const { version } = await head();
    expect(preview.version).toBe(version);
    expect(preview.document.modelVersion).toBe(version);
    expect(preview.document.deliverables.map((s) => s.id)).toEqual([
      'business_sheet',
      'actors_raci',
      'data_flows',
      'rules_register',
    ]);
    const tables = Object.fromEntries(documentTables(preview.document).map((x) => [x.id, x]));
    // RACI : l'activité « Production comptable » porte les quatre rôles.
    const raci = tables['raci'];
    const production = raci?.rows.find((r) => r[0]?.includes('Production comptable'));
    expect(production).toBeDefined();
    expect(raci?.columns.length).toBeGreaterThan(4);
    expect(production?.filter((cell) => ['R', 'A', 'C', 'I'].includes(cell)).sort()).toEqual([
      'A',
      'C',
      'I',
      'R',
    ]);
    expect(tables['data_fields']?.rows).toHaveLength(2);
    expect(tables['flows']?.rows).toHaveLength(1);
    expect(tables['rules']?.rows).toHaveLength(2);
    // Les hypothèses restantes ne figurent nulle part.
    const text = JSON.stringify(preview.document);
    for (const label of hypothesisLabels.filter((l) => !confirmedHypothesisLabels.includes(l))) {
      expect(text).not.toContain(label);
    }
    for (const label of confirmedHypothesisLabels) expect(text).toContain(label);
    // Version précédente : moins d'éléments, et une version inconnue est refusée.
    const earlier = (await consultantA.call('GET', `${base}/deliverables?version=1`))
      .body as DeliverablesPreviewDto;
    expect(earlier.version).toBe(1);
    expect(documentTables(earlier.document).find((x) => x.id === 'rules')?.rows).toHaveLength(0);
    expect((await consultantA.call('GET', `${base}/deliverables?version=9999`)).status).toBe(404);
  });

  const files = new Map<ExportFormat, { artifact: ExportArtifactDto; bytes: Buffer }>();

  it('1. DOCX : les 4 sections, le RACI et les sources en annexe (relu avec mammoth)', async () => {
    const { artifact, bytes } = await exportAs('docx');
    files.set('docx', { artifact, bytes });
    const html = (await mammoth.convertToHtml({ buffer: bytes })).value;
    const text = (await mammoth.extractRawText({ buffer: bytes })).value;
    for (const title of [
      messages.exports.deliverable.business_sheet,
      messages.exports.deliverable.actors_raci,
      messages.exports.deliverable.data_flows,
      messages.exports.deliverable.rules_register,
      messages.exports.deliverable.annex,
    ]) {
      expect(html).toContain(`<h1>${title}</h1>`);
    }
    expect(html).toContain(`<h2>${messages.exports.caption.raci}</h2>`);
    expect(html).toContain('Production comptable');
    expect(html).toContain('Expert-comptable');
    // Sources en annexe : la description du métier, avec ses citations.
    expect(text).toContain(messages.exports.caption.sources);
    expect(text).toContain('Description du métier');
    expect(text).toContain(messages.exports.caption.citations);
    expect(text).toContain('Code de déontologie, article 12');
    // Statuts : éléments extraits et confirmés côte à côte [PO-11].
    expect(text).toContain(messages.exports.status.extracted);
    expect(text).toContain(messages.exports.status.confirmed);
  });

  it('2. XLSX : les feuilles attendues avec les en-têtes i18n (relu avec exceljs)', async () => {
    const { artifact, bytes } = await exportAs('xlsx');
    files.set('xlsx', { artifact, bytes });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    const names = workbook.worksheets.map((s) => s.name);
    for (const name of [
      messages.exports.sheet.traits,
      messages.exports.sheet.glossary,
      messages.exports.sheet.actors,
      messages.exports.sheet.raci,
      messages.exports.sheet.dataObjects,
      messages.exports.sheet.dataFields,
      messages.exports.sheet.flows,
      messages.exports.sheet.rules,
      messages.exports.sheet.sources,
    ]) {
      expect(names).toContain(name);
    }
    const header = (name: string): string[] =>
      (workbook.getWorksheet(name)?.getRow(1).values as string[]).slice(1);
    expect(header(messages.exports.sheet.rules)).toContain(messages.exports.col.statement);
    expect(header(messages.exports.sheet.glossary)).toEqual([
      messages.exports.col.code,
      messages.exports.col.term,
      messages.exports.col.definition,
      messages.exports.col.synonyms,
      messages.exports.col.status,
      messages.exports.col.sources,
    ]);
    expect(header(messages.exports.sheet.raci)[0]).toBe(messages.exports.raci.activity);
    expect(workbook.getWorksheet(messages.exports.sheet.rules)?.rowCount).toBe(3);
    expect(workbook.getWorksheet(messages.exports.sheet.dataFields)?.rowCount).toBe(3);
  });

  it('3. PDF : signets et texte extractible (relu avec unpdf)', { timeout: 60_000 }, async () => {
    const { artifact, bytes } = await exportAs('pdf');
    files.set('pdf', { artifact, bytes });
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const outline = (await pdf.getOutline()) as { title: string; items: unknown[] }[] | null;
    expect(outline).not.toBeNull();
    const titles = (outline ?? []).flatMap(function walk(item: {
      title: string;
      items: unknown[];
    }): string[] {
      return [item.title, ...(item.items as (typeof item)[]).flatMap(walk)];
    });
    for (const title of [
      messages.exports.deliverable.business_sheet,
      messages.exports.deliverable.actors_raci,
      messages.exports.deliverable.data_flows,
      messages.exports.deliverable.rules_register,
      messages.exports.deliverable.annex,
    ]) {
      expect(titles).toContain(title);
    }
    const extracted = await extractText(pdf, { mergePages: true });
    const text = extracted.text.replace(/\s+/g, ' ');
    expect(text).toContain('Production comptable');
    expect(text).toContain('Transmission des pièces');
    expect(text).toContain('Client injoignable');
    expect(Buffer.from(bytes).includes('/StructTreeRoot')).toBe(true);
  });

  it('4. une hypothèse non confirmée n’apparaît dans aucun des 3 formats', async () => {
    const rejected = hypothesisLabels.filter((l) => !confirmedHypothesisLabels.includes(l));
    expect(rejected).toHaveLength(3);
    const docx = files.get('docx')?.bytes ?? Buffer.alloc(0);
    const xlsx = files.get('xlsx')?.bytes ?? Buffer.alloc(0);
    const pdf = files.get('pdf')?.bytes ?? Buffer.alloc(0);
    const docxText = (await mammoth.extractRawText({ buffer: docx })).value;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx as unknown as ArrayBuffer);
    const cells: string[] = [];
    workbook.eachSheet((sheet) =>
      sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? '')))),
    );
    const pdfText = (
      await extractText(await getDocumentProxy(new Uint8Array(pdf)), { mergePages: true })
    ).text.replace(/\s+/g, ' ');
    for (const label of rejected) {
      expect(docxText, `DOCX : ${label}`).not.toContain(label);
      expect(cells.join('\n'), `XLSX : ${label}`).not.toContain(label);
      expect(pdfText, `PDF : ${label}`).not.toContain(label);
    }
    // Les hypothèses confirmées, elles, y sont.
    for (const label of confirmedHypothesisLabels) {
      expect(docxText).toContain(label);
      expect(cells.join('\n')).toContain(label);
    }
  });

  it('5. l’artefact est lié à la version du modèle et porte son empreinte sha256', async () => {
    const { version } = await head();
    for (const format of ['docx', 'xlsx', 'pdf'] as const) {
      const entry = files.get(format);
      if (entry === undefined) throw new Error(`Export ${format} absent.`);
      expect(entry.artifact).toMatchObject({
        format,
        modelVersion: version,
        createdBy: SEED_IDS.consultantA,
      });
      expect(entry.artifact.filename).toBe(`dossier-analyse-cabinet-pilote-v${version}.${format}`);
      expect(entry.artifact.sha256).toBe(sha256Hex(entry.bytes));
      const row = await admin.query(
        'select kind, purpose, model_version, sha256, storage_key from artifacts where id = $1',
        [entry.artifact.id],
      );
      expect(row.rows[0]).toMatchObject({
        kind: format,
        purpose: 'analysis_dossier',
        model_version: version,
        sha256: entry.artifact.sha256,
      });
      expect(row.rows[0]?.storage_key).toContain(
        `missions/${MISSION}/exports/${entry.artifact.id}/`,
      );
    }
  });

  it('DOCX et XLSX sont identiques d’un export à l’autre pour une même version (déterminisme)', async () => {
    const { version } = await head();
    for (const format of ['docx', 'xlsx'] as const) {
      const first = files.get(format);
      const started = (await consultantA.call('POST', `${base}/exports`, { format }))
        .body as StartExportResult;
      expect(started.modelVersion).toBe(version);
      await waitRun(started.runId);
      const all = (await consultantA.call('GET', `${base}/exports`)).body as ExportArtifactDto[];
      const same = all.filter((a) => a.format === format && a.modelVersion === version);
      expect(same.length).toBeGreaterThanOrEqual(2);
      expect(new Set(same.map((a) => a.sha256)).size).toBe(1);
      expect(same[0]?.sha256).toBe(first?.artifact.sha256);
    }
  });

  it('un autre consultant voit les mêmes exports ; la liste est ordonnée du plus récent au plus ancien', async () => {
    const all = (await consultantB.call('GET', `${base}/exports`)).body as ExportArtifactDto[];
    expect(all.length).toBeGreaterThanOrEqual(5);
    const dates = all.map((a) => a.createdAt);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('un export est figé sur la version de tête de la demande, même si le modèle change ensuite', async () => {
    const before = await head();
    const started = (await consultantA.call('POST', `${base}/exports`, { format: 'docx' }))
      .body as StartExportResult;
    expect(started.modelVersion).toBe(before.version);
    const expert = byLabel(before.model, 'Expert-comptable');
    const changed = await consultantA.call('POST', `${base}/model/changes`, {
      changeSet: {
        baseVersion: before.version,
        cause: 'dialogue_edit',
        summary: 'Renommage après la demande d’export',
        ops: [{ op: 'update', id: expert.id, set: { label: 'Expert-comptable associé' } }],
      },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(201);
    await waitRun(started.runId);
    const all = (await consultantA.call('GET', `${base}/exports`)).body as ExportArtifactDto[];
    const frozen = all.find((a) => a.format === 'docx' && a.modelVersion === before.version);
    expect(frozen).toBeDefined();
    const url = (await consultantA.call('GET', `${base}/exports/${frozen?.id}/download-url`))
      .body as PresignedUrlDto;
    const bytes = Buffer.from(await (await fetch(url.url)).arrayBuffer());
    const text = (await mammoth.extractRawText({ buffer: bytes })).value;
    expect(text).toContain('Expert-comptable');
    expect(text).not.toContain('Expert-comptable associé');
    expect((await head()).version).toBe(before.version + 1);
  });

  it('un export en échec est signalé et n’écrit aucun artefact', async () => {
    const before = await admin.query('select count(*)::int as n from artifacts');
    // Un format valide mais une version inexistante : tâche forgée directement.
    const jobs = app.get(JobsService);
    const created = await admin.query(
      `insert into analysis_runs (mission_id, kind, status, progress, started_by)
       values ($1, 'export', 'queued', 0, $2) returning id`,
      [MISSION, SEED_IDS.consultantA],
    );
    const runId = created.rows[0]?.id as string;
    await jobs.send('export.create', {
      missionId: MISSION,
      runId,
      userId: SEED_IDS.consultantA,
      format: 'docx',
      modelVersion: 9999,
    });
    const done = await waitRun(runId);
    expect(done.status).toBe('failed');
    const after = await admin.query('select count(*)::int as n from artifacts');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('échantillons pour le PO (WP15_SAMPLES_DIR)', async () => {
    const dir = process.env['WP15_SAMPLES_DIR'];
    if (dir === undefined || dir === '') return;
    mkdirSync(dir, { recursive: true });
    for (const [format, entry] of files) {
      writeFileSync(`${dir}/dossier-analyse-pilote.${format}`, entry.bytes);
    }
  });
});
