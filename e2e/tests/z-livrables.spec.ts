import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PILOT_DESCRIPTION, pilotDeliverablesChangeSet } from '@processia/test-fixtures';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { ACCOUNTS, expectNoSeriousViolations, loginAnyState } from './support.js';

const SCREENSHOT = fileURLToPath(new URL('../../docs/wp/WP-15-livrables.png', import.meta.url));
const EDITOR_NAME = 'Description du métier du client';
const MISSION_NAME = 'Livrables E2E du pilote';
const MISSION_SLUG = 'livrables-e2e-du-pilote';
/** Hypothèses laissées sans décision : elles ne doivent figurer dans aucun livrable. */
const UNDECIDED = [
  'Saisonnalité de l’activité',
  'Logiciel de GED',
  'Commissaire aux comptes',
  'Contrôle de la balance',
];

/**
 * Livrables de l'étape 1 et exports (WP-15) sur le scénario factice du pilote : « Voir les
 * 4 livrables » depuis l'espace Analyse, aperçu HTML des quatre livrables (matrice RACI à
 * en-têtes de lignes et de colonnes), aucune hypothèse non décidée, exports Word, PDF et Excel
 * téléchargés puis relus (mammoth, exceljs, unpdf), second consultant mis à jour sans recharger,
 * validateur sans accès. Mission dédiée. `E2E_SCREENSHOT=1` écrit la capture remise au PO.
 */
test.describe.configure({ mode: 'serial' });

let missionId = '';

async function openAnalysis(page: Page): Promise<void> {
  await page.goto(`/missions/${missionId}/analyse`);
  await expect(page.getByText('Coédition active')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('textbox', { name: EDITOR_NAME })).toBeVisible();
}

async function paste(page: Page, text: string): Promise<void> {
  const editor = page.getByRole('textbox', { name: EDITOR_NAME });
  await editor.click();
  await editor.evaluate((node, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    node.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

const card = (page: Page, label: string): Locator =>
  page.getByTestId('hypothesis-card').filter({ hasText: label });

/** Télécharge le fichier d'une ligne de la liste « Fichiers produits » et le lit. */
async function download(page: Page, row: Locator): Promise<{ filename: string; bytes: Buffer }> {
  const [event] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('button', { name: /^Télécharger le fichier/ }).click(),
  ]);
  const path = await event.path();
  return { filename: event.suggestedFilename(), bytes: readFileSync(path) };
}

test.describe('livrables de l’étape 1 et exports du pilote', () => {
  test.setTimeout(300_000);

  test('mission dédiée avec deux consultants et un validateur', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.manager);
    const me = (await (await page.request.get('/api/me')).json()) as { csrfToken: string };
    const headers = { 'x-csrf-token': me.csrfToken };
    const clients = (await (await page.request.get('/api/clients')).json()) as { id: string }[];
    const created = await page.request.post('/api/missions', {
      headers,
      data: { clientId: clients[0]?.id, name: MISSION_NAME },
    });
    expect(created.status(), await created.text()).toBe(201);
    missionId = ((await created.json()) as { mission: { id: string } }).mission.id;
    const assignable = (await (
      await page.request.get(`/api/missions/${missionId}/assignable-users`)
    ).json()) as { id: string; email: string }[];
    const members: [string, string][] = [
      [ACCOUNTS.consultantA, 'consultant'],
      [ACCOUNTS.consultantB, 'consultant'],
      [ACCOUNTS.validator, 'validator'],
    ];
    for (const [email, missionRole] of members) {
      const user = assignable.find((candidate) => candidate.email === email);
      expect(user, email).toBeDefined();
      const assigned = await page.request.put(`/api/missions/${missionId}/members`, {
        headers,
        data: { userId: user?.id, missionRole },
      });
      expect(assigned.status(), await assigned.text()).toBe(200);
    }
    await context.close();
  });

  test('prépare le pilote : analyse, une hypothèse et la synthèse confirmées, saisies du consultant', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openAnalysis(page);
    await paste(page, PILOT_DESCRIPTION);
    await page.getByRole('button', { name: 'Analyser', exact: true }).click();
    await expect(page.getByText('Analyse terminée')).toBeVisible({ timeout: 60_000 });

    const section = page.getByTestId('hypotheses-section');
    await section.getByRole('button', { name: 'Proposer des hypothèses' }).click();
    await expect(page.getByText('Propositions prêtes')).toBeVisible({ timeout: 30_000 });
    await card(page, 'Liasse fiscale')
      .getByRole('button', { name: /^Accepter/ })
      .click();
    await expect(section.getByTestId('hypotheses-count')).toHaveText('(4)');
    await section.getByRole('button', { name: 'Proposer une synthèse du métier' }).click();
    await expect(page.getByText('Synthèse proposée')).toBeVisible({ timeout: 30_000 });
    await card(page, 'Synthèse du métier')
      .getByRole('button', { name: /^Accepter/ })
      .click();
    await expect(section.getByTestId('hypotheses-announcement')).toContainText(
      '« Synthèse du métier » est confirmée.',
    );

    // Données, flux, règles et RACI saisis par le consultant (le scénario factice n'en extrait pas).
    const me = (await (await page.request.get('/api/me')).json()) as {
      csrfToken: string;
      user: { id: string };
    };
    const head = (await (await page.request.get(`/api/missions/${missionId}/model`)).json()) as {
      version: number;
      model: { elements: Record<string, { id: string; label: string }> };
    };
    const ids = new Map(Object.values(head.model.elements).map((e) => [e.label, e.id]));
    const saved = await page.request.post(`/api/missions/${missionId}/model/changes`, {
      headers: { 'x-csrf-token': me.csrfToken },
      data: {
        changeSet: pilotDeliverablesChangeSet({
          baseVersion: head.version,
          userId: me.user.id,
          at: new Date().toISOString(),
          idOf: (label) => {
            const id = ids.get(label);
            if (id === undefined) throw new Error(`Élément absent : ${label}`);
            return id;
          },
        }),
      },
    });
    expect(saved.status(), await saved.text()).toBe(201);
    await context.close();
  });

  test('« Voir les 4 livrables » ouvre l’aperçu : 4 livrables, RACI accessible, aucune hypothèse non décidée', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openAnalysis(page);
    await page.getByRole('link', { name: 'Voir les 4 livrables' }).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/livrables$`));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Livrables de l’étape 1' }),
    ).toBeVisible();
    await expect(page.getByTestId('deliverables-version')).toContainText('Version du modèle');

    // Les quatre livrables, dans l'ordre du CDC 3.5.
    const titles = [
      'Fiche métier et glossaire',
      'Acteurs et matrice RACI',
      'Dictionnaire de données et flux',
      'Registre des règles',
    ];
    for (const title of titles) {
      await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
    }
    const nav = page.getByRole('navigation', { name: 'Les quatre livrables' });
    await expect(nav.getByRole('link')).toHaveText(titles);

    // Statuts : éléments extraits (source citée) et confirmés côte à côte [PO-11].
    const business = page.getByTestId('deliverable-business_sheet');
    await expect(business).toContainText('Synthèse du métier');
    await expect(business).toContainText('Liasse fiscale');
    await expect(page.getByTestId('table-traits')).toContainText('Extrait');
    await expect(page.getByTestId('table-traits')).toContainText('S1');

    // Matrice RACI : en-têtes de colonnes (acteurs) et de lignes (activités), quatre rôles.
    const raci = page.getByTestId('table-raci').locator('table');
    await expect(raci.locator('thead th[scope="col"]').first()).toHaveText('Activité');
    expect(await raci.locator('thead th[scope="col"]').count()).toBeGreaterThan(4);
    const production = raci.locator('tbody tr').filter({ hasText: 'Production comptable' });
    await expect(production.locator('th[scope="row"]')).toContainText('Production comptable');
    const roles = (await production.locator('td').allInnerTexts()).filter((cell) => cell !== '');
    expect(roles.sort()).toEqual(['A', 'C', 'I', 'R']);
    await expect(page.getByTestId('table-rules')).toContainText('Client injoignable');
    await expect(page.getByTestId('table-flows')).toContainText('Transmission des pièces');
    await expect(page.getByTestId('table-data_fields')).toContainText('Régime de TVA');

    // Aucune hypothèse non décidée ; l'information est donnée au consultant.
    const body = (await page.locator('main').innerText()) ?? '';
    for (const label of UNDECIDED) expect(body).not.toContain(label);
    await expect(page.getByText('4 hypothèse(s) en attente de décision')).toBeVisible();
    await page.getByRole('link', { name: 'Examiner les hypothèses' }).click();
    await expect(page).toHaveURL(/\/analyse#hypotheses$/);
    await page.goBack();
    await expect(page.getByTestId('deliverables-version')).toBeVisible();

    await expectNoSeriousViolations(page);
    await context.close();
  });

  test('exports Word, PDF et Excel : téléchargés et relus, sans hypothèse non décidée, empreinte affichée', async ({
    browser,
  }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await loginAnyState(pageA, ACCOUNTS.consultantA);
    await loginAnyState(pageB, ACCOUNTS.consultantB);
    for (const page of [pageA, pageB]) {
      await page.goto(`/missions/${missionId}/livrables`);
      await expect(page.getByTestId('deliverables-version')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('Aucun fichier produit pour le moment.')).toBeVisible();
    }
    const version = Number(
      /(\d+)\s*$/.exec((await pageA.getByTestId('deliverables-version').textContent()) ?? '')?.[1],
    );
    expect(version).toBeGreaterThan(1);

    const files = pageA.getByTestId('export-file');
    const downloads = new Map<string, { filename: string; bytes: Buffer }>();
    for (const [format, label] of [
      ['docx', 'Word'],
      ['xlsx', 'Excel'],
      ['pdf', 'PDF'],
    ] as const) {
      await pageA.getByRole('button', { name: `Exporter en ${label}` }).click();
      await expect(pageA.getByText(`Le fichier ${label} est prêt.`)).toBeVisible({
        timeout: 60_000,
      });
      const row = files.filter({ has: pageA.getByRole('rowheader', { name: label }) });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(String(version));
      const file = await download(pageA, row);
      expect(file.filename).toBe(`dossier-analyse-${MISSION_SLUG}-v${version}.${format}`);
      // L'empreinte affichée est celle du fichier téléchargé.
      const sha = createHash('sha256').update(file.bytes).digest('hex');
      await expect(row.locator('code')).toHaveAttribute('title', sha);
      await expect(row.locator('code')).toHaveText(`${sha.slice(0, 12)}…`);
      downloads.set(format, file);
    }
    await expect(files).toHaveCount(3);
    await expectNoSeriousViolations(pageA);
    if (process.env['E2E_SCREENSHOT']) {
      await pageA.screenshot({ path: SCREENSHOT, fullPage: true });
    }

    // Le second consultant voit les trois fichiers sans recharger.
    await expect(pageB.getByTestId('export-file')).toHaveCount(3, { timeout: 15_000 });

    // Word : quatre sections, RACI, sources en annexe.
    const docx = downloads.get('docx')?.bytes as Buffer;
    const html = (await mammoth.convertToHtml({ buffer: docx })).value;
    for (const title of [
      'Fiche métier et glossaire',
      'Acteurs et matrice RACI',
      'Dictionnaire de données et flux',
      'Registre des règles',
      'Annexe : sources et références',
    ]) {
      expect(html).toContain(`<h1>${title}</h1>`);
    }
    expect(html).toContain('Matrice RACI : activités et acteurs');
    expect(html).toContain('Production comptable');
    expect(html).toContain('Sources citées');
    expect(html).toContain('Liasse fiscale');

    // Excel : feuilles attendues, en-têtes en français.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(downloads.get('xlsx')?.bytes as unknown as ArrayBuffer);
    const names = workbook.worksheets.map((sheet) => sheet.name);
    for (const name of [
      'RACI',
      'Objets de données',
      'Champs de données',
      'Flux',
      'Règles',
      'Glossaire',
    ]) {
      expect(names).toContain(name);
    }
    expect((workbook.getWorksheet('Règles')?.getRow(1).values as string[]).slice(1, 4)).toEqual([
      'Code',
      'Règle',
      'Type',
    ]);

    // PDF : signets et texte extractible.
    const pdf = await getDocumentProxy(new Uint8Array(downloads.get('pdf')?.bytes as Buffer));
    interface Bookmark {
      title: string;
      items: Bookmark[];
    }
    const flatten = (items: Bookmark[]): string[] =>
      items.flatMap((item) => [item.title, ...flatten(item.items)]);
    const outline = (await pdf.getOutline()) as Bookmark[] | null;
    expect(flatten(outline ?? [])).toContain('Registre des règles');
    const pdfText = (await extractText(pdf, { mergePages: true })).text.replace(/\s+/g, ' ');
    expect(pdfText).toContain('Production comptable');

    // Aucune hypothèse non décidée dans aucun des trois formats.
    const cells: string[] = [];
    workbook.eachSheet((sheet) =>
      sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? '')))),
    );
    const raw = (await mammoth.extractRawText({ buffer: docx })).value;
    for (const label of UNDECIDED) {
      expect(raw, `Word : ${label}`).not.toContain(label);
      expect(cells.join('\n'), `Excel : ${label}`).not.toContain(label);
      expect(pdfText, `PDF : ${label}`).not.toContain(label);
    }
    await contextA.close();
    await contextB.close();
  });

  test('le validateur n’a accès ni aux livrables de travail ni aux exports', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.validator);
    await page.goto(`/missions/${missionId}/livrables`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Livrables de l’étape 1' }),
    ).toBeVisible();
    await expect(page.getByText('réservés aux consultants')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Exporter en/ })).toHaveCount(0);
    await expectNoSeriousViolations(page);
    const me = (await (await page.request.get('/api/me')).json()) as { csrfToken: string };
    expect((await page.request.get(`/api/missions/${missionId}/deliverables`)).status()).toBe(403);
    expect((await page.request.get(`/api/missions/${missionId}/exports`)).status()).toBe(403);
    const started = await page.request.post(`/api/missions/${missionId}/exports`, {
      headers: { 'x-csrf-token': me.csrfToken },
      data: { format: 'docx' },
    });
    expect(started.status()).toBe(403);
    await context.close();
  });
});
