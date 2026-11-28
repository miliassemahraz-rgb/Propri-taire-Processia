import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { PILOT_DESCRIPTION } from '@processia/test-fixtures';
import { ACCOUNTS, expectNoSeriousViolations, loginAnyState } from './support.js';

const SCREENSHOT_ASIS = fileURLToPath(
  new URL('../../docs/wp/WP-21-validation-asis.png', import.meta.url),
);
const SCREENSHOT_DIAGNOSTIC = fileURLToPath(
  new URL('../../docs/wp/WP-21-diagnostic.png', import.meta.url),
);
const EDITOR_NAME = 'Description du métier du client';
const MISSION_NAME = 'Diagnostic E2E du pilote';
const FAMILIES = ['waste', 'flow_and_delay', 'organisation', 'risk_compliance'] as const;

/**
 * Validation de l'AS-IS et diagnostic (WP-21) : le consultant soumet l'AS-IS depuis la cartographie,
 * le validateur lit la version figée niveau par niveau, la commente et la valide (la mission passe en
 * « transformation »), puis le consultant lance le diagnostic : constats par famille, localisation sur
 * la cartographie, confirmation et rejet. Avant la validation, le diagnostic répond 409. Mission
 * dédiée ; les enchaînements du pilote sont préparés par l'API (le parcours UI est celui de WP-17).
 * `E2E_SCREENSHOT=1` écrit les captures remises au PO.
 */
test.describe.configure({ mode: 'serial' });

let missionId = '';

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
  for (let i = 0; i < 600; i += 1) {
    const res = await page.request.get(`/api/missions/${missionId}/runs/${runId}`);
    const run = (await res.json()) as { status: string };
    if (run.status === 'succeeded') return;
    if (run.status === 'failed') throw new Error(`Exécution ${runId} en échec.`);
    await page.waitForTimeout(500);
  }
  throw new Error(`Exécution ${runId} non terminée.`);
}

test.describe('validation de l’AS-IS et diagnostic', () => {
  test.setTimeout(300_000);

  test('mission dédiée : un consultant et le validateur', async ({ browser }) => {
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

  test('préparation : dossier validé, enchaînements du pilote construits puis confirmés', async ({
    browser,
  }) => {
    const consultant = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await consultant.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await page.goto(`/missions/${missionId}/analyse`);
    await expect(page.getByText('Coédition active')).toBeVisible({ timeout: 15_000 });
    await paste(page, PILOT_DESCRIPTION);
    await page.getByRole('button', { name: 'Analyser', exact: true }).click();
    await expect(page.getByText('Analyse terminée')).toBeVisible({ timeout: 60_000 });
    const headers = await csrf(page);
    const api = `/api/missions/${missionId}`;

    const dossier = await page.request.post(`${api}/submissions`, {
      headers,
      data: { kind: 'analysis_dossier' },
    });
    expect(dossier.status(), await dossier.text()).toBe(201);
    const dossierId = ((await dossier.json()) as { id: string }).id;

    const client = await browser.newContext();
    const validatorPage = await client.newPage();
    await loginAnyState(validatorPage, ACCOUNTS.validator);
    const ok = await validatorPage.request.post(`${api}/submissions/${dossierId}/validate`, {
      headers: await csrf(validatorPage),
      data: {},
    });
    expect(ok.status(), await ok.text()).toBe(200);
    await client.close();

    const flows = await page.request.post(`${api}/mapping/flows`, { headers, data: {} });
    expect(flows.status(), await flows.text()).toBe(201);
    await waitRun(page, ((await flows.json()) as { runId: string }).runId);

    const model = (await (await page.request.get(`${api}/model`)).json()) as {
      model: {
        elements: Record<string, { kind: string; level?: string; label: string; id: string }>;
      };
    };
    const relance = Object.values(model.model.elements).find(
      (e) =>
        e.kind === 'activity' && e.level === 'task' && e.label === 'Relance des pièces manquantes',
    );
    expect(relance).toBeDefined();
    const detail = await page.request.post(`${api}/mapping/flows`, {
      headers,
      data: { detailTaskIds: [relance?.id] },
    });
    expect(detail.status(), await detail.text()).toBe(201);
    await waitRun(page, ((await detail.json()) as { runId: string }).runId);

    const overview = (await (await page.request.get(`${api}/mapping/processes`)).json()) as {
      processes: { id: string }[];
    };
    for (const process of overview.processes) {
      const res = await page.request.post(`${api}/mapping/processes/${process.id}/decision`, {
        headers,
        data: { decision: 'accept' },
      });
      expect([201, 409], await res.text()).toContain(res.status());
    }
    const parent = (
      Object.values(model.model.elements) as unknown as { id: string; parentId?: string }[]
    ).find((e) => e.id === relance?.id)?.parentId;
    await page.request.post(`${api}/mapping/processes/${parent}/decision`, {
      headers,
      data: { decision: 'accept', taskId: relance?.id },
    });
    await consultant.close();
  });

  test('critère 1 : avant la validation de l’AS-IS, la page est verrouillée et l’API répond 409', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    const nav = page.getByRole('navigation', { name: /mission/i });
    await page.goto(`/missions/${missionId}/cartographie`);
    await nav.getByRole('link', { name: 'Diagnostic' }).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/diagnostic$`));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Diagnostic de l’AS-IS' }),
    ).toBeVisible();
    await expect(page.getByTestId('diagnostic-locked')).toContainText(
      'Le diagnostic s’ouvre quand le client a validé l’AS-IS.',
    );
    await expect(page.getByRole('button', { name: 'Lancer le diagnostic' })).toHaveCount(0);
    const locked = await page.request.get(`/api/missions/${missionId}/diagnostic`);
    expect(locked.status()).toBe(409);
    expect(((await locked.json()) as { code: string }).code).toBe('PHASE_LOCKED');
    await expectNoSeriousViolations(page);
    await context.close();
  });

  test('le consultant soumet l’AS-IS depuis la cartographie, avec la liste des hypothèses exclues', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await page.goto(`/missions/${missionId}/cartographie`);
    const card = page.getByTestId('asis-card');
    await expect(card).toContainText('Valider l’AS-IS');
    await expectNoSeriousViolations(page);
    await card.getByRole('button', { name: 'Soumettre l’AS-IS au validateur' }).click();
    const dialog = page.getByTestId('submit-dialog');
    await expect(dialog).toContainText('de la cartographie', { timeout: 15_000 });
    await expect(dialog.getByTestId('submit-included')).toContainText('éléments seront soumis');
    await expectNoSeriousViolations(page);
    await dialog.getByRole('button', { name: /^Soumettre la version/ }).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/validation$`), {
      timeout: 30_000,
    });
    await expect(page.getByTestId('step-as_is')).toContainText('2. AS-IS : en cours de validation');
    await context.close();
  });

  test('le validateur parcourt la cartographie figée, la commente, puis valide l’AS-IS', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.validator);
    await page.goto(`/missions/${missionId}/validation`);
    await expect(page.getByTestId('submission-title')).toHaveText('Soumission n°1');
    await expect(page.getByTestId('step-as_is')).toContainText('2. AS-IS');

    await page.getByRole('tab', { name: 'Cartographie' }).click();
    const mapping = page.getByTestId('frozen-mapping');
    await expect(mapping).toBeVisible({ timeout: 30_000 });
    await expect(mapping).toHaveAttribute('data-diagram', 'L0');
    await expect(page.getByTestId('frozen-diagram-title')).toHaveText('Cartographie globale');
    await expect(mapping.getByTestId('simple-card')).toHaveCount(14);

    // Descente jusqu'au niveau 2 d'un processus, par la vue simplifiée.
    await mapping
      .getByTestId('simple-card')
      .filter({ hasText: 'Collecte documentaire' })
      .locator('xpath=..')
      .getByTestId('simple-open')
      .click();
    await expect(mapping).toHaveAttribute('data-diagram', /^L1:/);
    await mapping
      .getByTestId('simple-card')
      .filter({ hasText: 'Relances clients' })
      .locator('xpath=..')
      .getByTestId('simple-open')
      .click();
    await expect(mapping).toHaveAttribute('data-diagram', /^L2:/);
    await expect(
      mapping.getByTestId('simple-card').filter({ hasText: 'Début' }).first(),
    ).toBeVisible();
    // Aucune hypothèse dans la version figée : aucun marqueur « Hypothèse ».
    await expect(mapping.getByText('Hypothèse', { exact: true })).toHaveCount(0);

    // Alternative textuelle.
    await page.getByTestId('frozen-view-text').click();
    await expect(mapping.getByTestId('text-view')).toBeVisible();
    await page.getByTestId('frozen-view-simple').click();

    // Commenter une étape.
    await mapping
      .getByTestId('simple-card')
      .filter({ hasText: 'Relance des pièces manquantes' })
      .first()
      .click();
    const thread = mapping.getByTestId('comment-thread');
    await thread
      .getByRole('textbox', { name: 'Votre commentaire' })
      .fill('La relance part-elle toujours à J+7 ?');
    await thread.getByRole('button', { name: 'Envoyer' }).click();
    await expect(thread.getByTestId('comment')).toContainText('La relance part-elle toujours', {
      timeout: 15_000,
    });
    await expectNoSeriousViolations(page);

    if (process.env['E2E_SCREENSHOT']) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: SCREENSHOT_ASIS });
    }

    // Décision : la phase passe en « transformation ».
    await page.getByRole('button', { name: 'Valider le dossier' }).click();
    const dialog = page.getByTestId('validate-dialog');
    await dialog
      .getByRole('textbox', { name: 'Commentaire de validation (facultatif)' })
      .fill('AS-IS conforme à notre fonctionnement actuel.');
    await dialog.getByRole('button', { name: 'Confirmer la validation' }).click();
    await expect(page.getByTestId('validated-banner')).toContainText('validé le', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('step-as_is')).toContainText('2. AS-IS : validé');
    const mission = (await (await page.request.get(`/api/missions/${missionId}`)).json()) as {
      phase: string;
    };
    expect(mission.phase).toBe('transformation');
    // Le validateur n'a pas accès au diagnostic.
    expect((await page.request.get(`/api/missions/${missionId}/diagnostic`)).status()).toBe(403);
    await context.close();
  });

  test('le consultant lance le diagnostic : constats par famille, localisés sur la carte', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await page.goto(`/missions/${missionId}/diagnostic`);
    await expect(page.getByTestId('diagnostic-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('diagnostic-summary')).toHaveText(/^0 constats/);
    await expectNoSeriousViolations(page);

    await page.getByTestId('run-diagnostic').click();
    await expect(page.getByTestId('diagnostic-summary')).not.toHaveText(/^0 constats/, {
      timeout: 120_000,
    });
    await expect(page.getByTestId('diagnostic-progress')).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId('diagnostic-failure')).toHaveCount(0);

    // Critère 3 : au moins un constat par famille.
    for (const family of FAMILIES) {
      const section = page.locator(`[data-testid="family-section"][data-family="${family}"]`);
      await expect(section.getByTestId('finding-card').first()).toBeVisible();
    }
    // Critère 4 : origines.
    const byRule = page.locator('[data-testid="finding-card"][data-finding-by="rule"]').first();
    await expect(byRule.getByTestId('finding-origin')).toContainText('Règle automatique');
    await expect(byRule.getByTestId('finding-origin')).toContainText('Règle de calcul');
    const byAi = page.locator('[data-testid="finding-card"][data-finding-by="ai"]').first();
    await expect(byAi.getByTestId('finding-origin')).toContainText('Proposé par l’IA');
    await expect(byAi).toHaveAttribute('data-finding-status', 'hypothesis');
    await expect(byAi).toContainText('Hypothèse');
    await expectNoSeriousViolations(page);

    if (process.env['E2E_SCREENSHOT']) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: SCREENSHOT_DIAGNOSTIC });
    }

    // Localisation : le lien ouvre la cartographie sur l'élément, avec son marqueur de constat.
    const link = byAi.getByTestId('finding-location-link').first();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/cartographie\\?element=`));
    const viewer = page.getByTestId('mapping-viewer');
    await expect(viewer).toBeVisible({ timeout: 30_000 });
    await expect(viewer).toHaveAttribute('data-diagram', /^L[123]:/);
    await page.getByTestId('view-simple').click();
    await expect(viewer.locator('.map-tag--finding').first()).toBeVisible();
    await expectNoSeriousViolations(page);
    await context.close();
  });

  test('le consultant confirme un constat et en rejette un autre', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await page.goto(`/missions/${missionId}/diagnostic`);
    const cards = page.locator('[data-testid="finding-card"][data-finding-by="ai"]');
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    const first = cards.first();
    const firstCode = (await first.getAttribute('data-finding-code')) as string;
    await first
      .getByRole('button', { name: new RegExp(`^Confirmer le constat ${firstCode}`) })
      .click();
    await expect(
      page.locator(`[data-testid="finding-card"][data-finding-code="${firstCode}"]`),
    ).toHaveAttribute('data-finding-status', 'confirmed', { timeout: 15_000 });
    await expect(
      page.locator(`[data-testid="finding-card"][data-finding-code="${firstCode}"]`),
    ).not.toContainText('Confirmer');

    const second = page
      .locator('[data-testid="finding-card"][data-finding-status="hypothesis"]')
      .first();
    const secondCode = (await second.getAttribute('data-finding-code')) as string;
    await second
      .getByRole('button', { name: new RegExp(`^Rejeter le constat ${secondCode}`) })
      .click();
    await page
      .getByRole('textbox', { name: 'Motif du rejet (facultatif)' })
      .fill('Déjà connu du client.');
    await page.getByRole('button', { name: 'Rejeter le constat', exact: true }).click();
    await expect(
      page.locator(`[data-testid="finding-card"][data-finding-code="${secondCode}"]`),
    ).toHaveCount(0, { timeout: 15_000 });
    await expectNoSeriousViolations(page);
    await context.close();
  });
});
