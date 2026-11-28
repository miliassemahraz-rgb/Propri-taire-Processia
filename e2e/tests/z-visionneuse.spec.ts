import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { PILOT_DESCRIPTION } from '@processia/test-fixtures';
import { ACCOUNTS, expectNoSeriousViolations, loginAnyState } from './support.js';

const SCREENSHOT = fileURLToPath(new URL('../../docs/wp/WP-19-visionneuse.png', import.meta.url));
const EDITOR_NAME = 'Description du métier du client';
const MISSION_NAME = 'Visionneuse E2E du pilote';

/**
 * Interface de cartographie (WP-19) : après la validation du dossier et la construction des
 * enchaînements du pilote, un consultant parcourt les niveaux L0, P04, « Relances clients » puis
 * le niveau 3 de « Relance des pièces manquantes », en vue simplifiée, en alternative textuelle et
 * en BPMN complet ; ce qu'un autre consultant modifie apparaît sans recharger. Mission dédiée.
 * `E2E_SCREENSHOT=1` écrit la capture remise au PO.
 */
test.describe.configure({ mode: 'serial' });

let missionId = '';
let relancesId = '';
let relanceTaskId = '';

async function csrf(page: Page): Promise<Record<string, string>> {
  const me = (await (await page.request.get('/api/me')).json()) as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken };
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

async function waitRun(page: Page, runId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`/api/missions/${missionId}/runs/${runId}`)).json()) as {
            status: string;
          }
        ).status,
      { timeout: 180_000, intervals: [500, 1000, 2000] },
    )
    .toBe('succeeded');
}

async function openViewer(page: Page): Promise<void> {
  await page.goto(`/missions/${missionId}/cartographie`);
  await expect(page.getByTestId('mapping-viewer')).toBeVisible({ timeout: 30_000 });
}

/** Ouvre le niveau inférieur de la carte (ou de la ligne) portant ce code. */
async function drill(page: Page, code: string): Promise<void> {
  const card = page.locator(`[data-testid="simple-card"][data-element-code="${code}"]`);
  await card
    .locator('xpath=ancestor::li[1]')
    .getByRole('button', { name: /^Ouvrir le niveau inférieur de/ })
    .click();
}

test.describe('cartographie : visionneuse', () => {
  test.setTimeout(420_000);

  test('mission dédiée : deux consultants et le validateur', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.manager);
    const headers = await csrf(page);
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
    for (const [email, missionRole] of [
      [ACCOUNTS.consultantA, 'consultant'],
      [ACCOUNTS.consultantB, 'consultant'],
      [ACCOUNTS.validator, 'validator'],
    ] as const) {
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

  test('préparation : analyse, validation du dossier, enchaînements du pilote', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await page.goto(`/missions/${missionId}/analyse`);
    await expect(page.getByText('Coédition active')).toBeVisible({ timeout: 15_000 });
    await paste(page, PILOT_DESCRIPTION);
    await page.getByRole('button', { name: 'Analyser', exact: true }).click();
    await expect(page.getByText('Analyse terminée')).toBeVisible({ timeout: 60_000 });

    const submitted = await page.request.post(`/api/missions/${missionId}/submissions`, {
      headers: await csrf(page),
      data: { kind: 'analysis_dossier' },
    });
    expect(submitted.status(), await submitted.text()).toBe(201);
    const submissionId = ((await submitted.json()) as { id: string }).id;

    const clientContext = await browser.newContext();
    const validatorPage = await clientContext.newPage();
    await loginAnyState(validatorPage, ACCOUNTS.validator);
    const validated = await validatorPage.request.post(
      `/api/missions/${missionId}/submissions/${submissionId}/validate`,
      { headers: await csrf(validatorPage), data: {} },
    );
    expect(validated.status(), await validated.text()).toBe(200);
    await clientContext.close();

    // Tous les enchaînements, puis le niveau 3 de « Relance des pièces manquantes ».
    const headers = await csrf(page);
    const all = await page.request.post(`/api/missions/${missionId}/mapping/flows`, {
      headers,
      data: {},
    });
    expect(all.status(), await all.text()).toBe(201);
    await waitRun(page, ((await all.json()) as { runId: string }).runId);

    const overview = (await (
      await page.request.get(`/api/missions/${missionId}/mapping/processes`)
    ).json()) as {
      processes: { id: string; label: string; tasks: { id: string; label: string }[] }[];
    };
    const relances = overview.processes.find((p) => p.label === 'Relances clients');
    relancesId = relances?.id ?? '';
    relanceTaskId =
      relances?.tasks.find((task) => task.label === 'Relance des pièces manquantes')?.id ?? '';
    expect(relancesId).not.toBe('');
    expect(relanceTaskId).not.toBe('');
    const detail = await page.request.post(`/api/missions/${missionId}/mapping/flows`, {
      headers,
      data: { detailTaskIds: [relanceTaskId] },
    });
    expect(detail.status(), await detail.text()).toBe(201);
    await waitRun(page, ((await detail.json()) as { runId: string }).runId);

    // « Relances clients » est confirmé ; le reste du pilote garde ses hypothèses (marqueurs).
    const decided = await page.request.post(
      `/api/missions/${missionId}/mapping/processes/${relancesId}/decision`,
      { headers, data: { decision: 'accept' } },
    );
    expect(decided.status(), await decided.text()).toBe(201);
    await context.close();
  });

  test('critère 1 : navigation L0, P04, le processus de relance, puis le niveau 3 (vue simplifiée)', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openViewer(page);

    await expect(page.getByTestId('diagram-title')).toHaveText('Cartographie globale');
    await expect(page.getByTestId('crumb-current')).toHaveText('Niveau 0 · 14 macroprocessus');
    await expect(page.getByTestId('view-simple')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('simple-card')).toHaveCount(14);

    // L0 -> P04 (macroprocessus).
    await drill(page, 'P04');
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L1:/, {
      timeout: 15_000,
    });
    await expect(page.getByTestId('crumb-current')).toContainText('P04');
    await expect(page.getByTestId('crumb-current')).toContainText('(niveau 1)');
    await expect(page.getByTestId('diagram-title')).toBeFocused();

    // P04 -> « Relances clients » (processus, niveau 2).
    const relances = page.getByTestId('simple-card').filter({ hasText: 'Relances clients' });
    await expect(relances).toHaveCount(1);
    await relances
      .locator('xpath=ancestor::li[1]')
      .getByRole('button', { name: /^Ouvrir le niveau inférieur de/ })
      .click();
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L2:/);
    await expect(page.getByTestId('crumb-current')).toContainText('(niveau 2)');
    // Enchaînement construit : un début, des tâches et une fin.
    await expect(
      page.getByTestId('simple-card').filter({ hasText: 'Début' }).first(),
    ).toBeVisible();
    await expect(page.getByTestId('simple-card').filter({ hasText: 'Fin' }).first()).toBeVisible();

    // « Relance des pièces manquantes » -> niveau 3 : ses étapes.
    const task = page
      .getByTestId('simple-card')
      .filter({ hasText: 'Relance des pièces manquantes' });
    await expect(task).toHaveCount(1);
    await task
      .locator('xpath=ancestor::li[1]')
      .getByRole('button', { name: /^Ouvrir le niveau inférieur de/ })
      .click();
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L3:/);
    await expect(page.getByTestId('crumb-current')).toContainText('(niveau 3)');
    await expect(
      page.getByTestId('simple-card').filter({ hasText: 'Préparer' }).first(),
    ).toBeVisible();
    expect(await page.getByTestId('simple-card').count()).toBeGreaterThanOrEqual(6);

    // Fil d'Ariane : remonter au niveau 0, puis redescendre au clavier.
    await expect(page.getByTestId('crumb')).toHaveCount(3);
    await page.getByTestId('crumb').first().click();
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', 'L0');
    const open = page
      .locator('[data-testid="simple-card"][data-element-code="P04"]')
      .locator('xpath=ancestor::li[1]')
      .getByTestId('simple-open');
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L1:/);
    await page.getByTestId('level-up').click();
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', 'L0');
    await context.close();
  });

  test('critère 2 : la vue simplifiée, l’alternative textuelle et le BPMN listent les mêmes étapes', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openViewer(page);
    await drill(page, 'P04');
    await page
      .getByTestId('simple-card')
      .filter({ hasText: 'Relances clients' })
      .locator('xpath=ancestor::li[1]')
      .getByRole('button', { name: /^Ouvrir le niveau inférieur de/ })
      .click();
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L2:/);

    const ids = async (selector: string): Promise<string[]> =>
      (
        await page
          .locator(selector)
          .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-element-id') ?? ''))
      ).sort();
    const fromSimple = await ids('[data-testid="simple-card"]');
    expect(fromSimple.length).toBeGreaterThan(5);

    await page.getByTestId('view-text').click();
    await expect(page.getByTestId('text-view')).toBeVisible();
    expect(await ids('[data-testid="text-row"]')).toEqual(fromSimple);

    // BPMN : une forme par étape (activités, événements, passerelles).
    await page.getByTestId('view-bpmn').click();
    const canvas = page.getByTestId('bpmn-canvas');
    await expect(canvas).toHaveAttribute('data-diagram', /^L2:/, { timeout: 30_000 });
    const shapes = canvas.locator(
      '.djs-element.djs-shape[data-element-id^="Activity_"]:not([data-element-id$="_label"]), .djs-element.djs-shape[data-element-id^="Event_"]:not([data-element-id$="_label"]), .djs-element.djs-shape[data-element-id^="Gateway_"]:not([data-element-id$="_label"])',
    );
    await expect(shapes).toHaveCount(fromSimple.length);
    await context.close();
  });

  test('le BPMN : sélection au clic et au clavier, panneau, descente par double-clic, hypothèses marquées', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openViewer(page);
    await page.getByTestId('view-bpmn').click();
    const canvas = page.getByTestId('bpmn-canvas');
    await expect(canvas).toHaveAttribute('data-diagram', 'L0', { timeout: 30_000 });
    await expect(
      canvas.locator(
        '.djs-element.djs-shape[data-element-id^="Activity_"]:not([data-element-id$="_label"])',
      ),
    ).toHaveCount(14);

    // Clavier : flèches pour parcourir, le panneau suit.
    await canvas.focus();
    await page.keyboard.press('Home');
    const label = page.getByTestId('panel-label');
    await expect(page.getByTestId('viewer-announcement')).toContainText('Étape sélectionnée : 1.');
    const first = await label.textContent();
    await page.keyboard.press('ArrowRight');
    await expect(label).not.toHaveText(first ?? '');
    await expect(page.getByTestId('viewer-announcement')).toContainText('Étape sélectionnée : 2.');

    // Clic sur P04, puis double-clic : on descend.
    const p04 = canvas
      .locator('.djs-element.djs-shape[data-element-id^="Activity_"]')
      .filter({ hasText: 'Collecte documentaire' });
    await p04.click();
    await expect(label).toContainText('P04');
    await page.getByTestId('panel-open').click();
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L1:/);
    await expect(canvas).toHaveAttribute('data-diagram', /^L1:/, { timeout: 30_000 });

    // Niveau 2 d'un processus enchaîné : les hypothèses ont un contour pointillé.
    const process = canvas
      .locator(
        '.djs-element.djs-shape[data-element-id^="Activity_"]:not([data-element-id$="_label"])',
      )
      .first();
    await process.dblclick();
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L2:/);
    await expect(canvas).toHaveAttribute('data-diagram', /^L2:/, { timeout: 30_000 });
    await expect(canvas.locator('.djs-element.processia-hypothesis').first()).toBeVisible();
    await expectNoSeriousViolations(page);
    await context.close();
  });

  test('critère 3 : axe-core et clavier sur les vues simplifiée et textuelle', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openViewer(page);
    await expectNoSeriousViolations(page);

    // Niveau 3 en vue simplifiée, puis en alternative textuelle.
    await drill(page, 'P04');
    await page
      .getByTestId('simple-card')
      .filter({ hasText: 'Relances clients' })
      .locator('xpath=ancestor::li[1]')
      .getByRole('button', { name: /^Ouvrir le niveau inférieur de/ })
      .click();
    await page
      .getByTestId('simple-card')
      .filter({ hasText: 'Relance des pièces manquantes' })
      .locator('xpath=ancestor::li[1]')
      .getByRole('button', { name: /^Ouvrir le niveau inférieur de/ })
      .click();
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L3:/);
    await page.getByTestId('simple-card').first().click();
    await expectNoSeriousViolations(page);

    await page.getByTestId('view-text').click();
    await expect(page.getByTestId('text-view')).toBeVisible();
    // La sélection faite dans la vue simplifiée est reportée dans l'alternative textuelle.
    await expect(page.locator('[data-testid="text-row"][aria-current="true"]')).toHaveCount(1);
    await expectNoSeriousViolations(page);

    // Tout se fait au clavier : une étape se sélectionne par Entrée, le panneau suit.
    const buttons = page.getByTestId('text-row').nth(2).getByRole('button').first();
    await buttons.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="text-row"][aria-current="true"]')).toHaveAttribute(
      'data-element-code',
      /.+/,
    );
    await expect(page.getByTestId('element-panel')).toHaveAttribute('data-element-id', /.+/);

    // Vue BPMN complète (mode expert) : aucune violation grave non plus.
    await page.getByTestId('view-bpmn').click();
    await expect(page.getByTestId('bpmn-canvas')).toHaveAttribute('data-diagram', /^L3:/, {
      timeout: 30_000,
    });
    await expectNoSeriousViolations(page);
    await context.close();
  });

  test('critère 4 : la modification d’un consultant apparaît chez l’autre en moins de 2 s', async ({
    browser,
  }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await loginAnyState(pageA, ACCOUNTS.consultantA);
    await loginAnyState(pageB, ACCOUNTS.consultantB);
    await openViewer(pageA);
    await expect(pageA.getByText('Coédition active')).toBeVisible({ timeout: 15_000 });

    // B renomme « Relances clients » ; A, qui regarde le niveau 1 de P04, le voit apparaître.
    await drill(pageA, 'P04');
    await expect(pageA.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L1:/);
    await expect(
      pageA.getByTestId('simple-card').filter({ hasText: 'Relances clients' }),
    ).toHaveCount(1);
    const newLabel = 'Relances clients (révisé par B)';
    const model = (await (await pageB.request.get(`/api/missions/${missionId}/model`)).json()) as {
      version: number;
    };
    const started = Date.now();
    const changed = await pageB.request.post(`/api/missions/${missionId}/model/changes`, {
      headers: await csrf(pageB),
      data: {
        changeSet: {
          baseVersion: model.version,
          cause: 'dialogue_edit',
          summary: 'Renommage depuis un autre consultant',
          ops: [{ op: 'update', id: relancesId, set: { label: newLabel } }],
        },
      },
    });
    expect(changed.status(), await changed.text()).toBe(201);
    await expect(pageA.getByTestId('simple-card').filter({ hasText: newLabel })).toHaveCount(1, {
      timeout: 2_000,
    });
    expect(Date.now() - started).toBeLessThan(4_000);

    // L'alternative textuelle suit aussi, et le BPMN est relu à la nouvelle version.
    await pageA.getByTestId('view-text').click();
    await expect(
      pageA.getByTestId('text-row').getByRole('button', {
        name: /^Sélectionner l’étape \d+ : Relances clients \(révisé par B\)$/,
      }),
    ).toHaveCount(1);
    await pageA.getByTestId('view-bpmn').click();
    await expect(pageA.getByTestId('bpmn-canvas')).toHaveAttribute('data-diagram', /^L1:/, {
      timeout: 30_000,
    });
    await expect(pageA.getByTestId('bpmn-canvas').getByText(newLabel)).toBeVisible({
      timeout: 15_000,
    });
    // Retour au libellé d'origine (le modèle sert aussi à la capture).
    const latest = (await (await pageB.request.get(`/api/missions/${missionId}/model`)).json()) as {
      version: number;
    };
    const restored = await pageB.request.post(`/api/missions/${missionId}/model/changes`, {
      headers: await csrf(pageB),
      data: {
        changeSet: {
          baseVersion: latest.version,
          cause: 'dialogue_edit',
          summary: 'Libellé d’origine',
          ops: [{ op: 'update', id: relancesId, set: { label: 'Relances clients' } }],
        },
      },
    });
    expect(restored.status(), await restored.text()).toBe(201);
    await expect(
      pageA.getByTestId('bpmn-canvas').getByText('Relances clients').first(),
    ).toBeVisible({
      timeout: 15_000,
    });
    await contextA.close();
    await contextB.close();
  });

  test('capture de la page pour le PO', async ({ browser }) => {
    test.skip(!process.env['E2E_SCREENSHOT'], 'Capture demandée par E2E_SCREENSHOT=1.');
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openViewer(page);
    await drill(page, 'P04');
    await page
      .getByTestId('simple-card')
      .filter({ hasText: 'Relances clients' })
      .locator('xpath=ancestor::li[1]')
      .getByRole('button', { name: /^Ouvrir le niveau inférieur de/ })
      .click();
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L2:/);
    await page
      .getByTestId('simple-card')
      .filter({ hasText: 'Relance des pièces manquantes' })
      .locator('xpath=ancestor::li[1]')
      .getByRole('button', { name: /^Ouvrir le niveau inférieur de/ })
      .click();
    await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L3:/);
    await page.getByTestId('simple-card').nth(2).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: SCREENSHOT });
    const preview = process.env['E2E_PREVIEW_DIR'];
    if (preview) {
      await page.getByTestId('view-text').click();
      await page.screenshot({ path: `${preview}/texte.png`, fullPage: true });
      await page.getByTestId('view-bpmn').click();
      await expect(page.getByTestId('bpmn-canvas')).toHaveAttribute('data-diagram', /^L3:/, {
        timeout: 30_000,
      });
      await page.screenshot({ path: `${preview}/bpmn.png`, fullPage: true });
    }
    await context.close();
  });
});
