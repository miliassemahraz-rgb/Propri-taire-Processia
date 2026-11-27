import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { PILOT_DESCRIPTION } from '@processia/test-fixtures';
import { ACCOUNTS, expectNoSeriousViolations, loginAnyState } from './support.js';

const SCREENSHOT = fileURLToPath(new URL('../../docs/wp/WP-17-cartographie.png', import.meta.url));
const EDITOR_NAME = 'Description du métier du client';
const MISSION_NAME = 'Cartographie E2E du pilote';

/**
 * Construction des enchaînements des processus (WP-17) : après la validation du dossier d'analyse
 * par le client, un consultant construit l'enchaînement d'un processus (P04 « Relances clients »),
 * le niveau 3 de « Relance des pièces manquantes », puis tous les autres processus ; chaque
 * élément proposé est une hypothèse, que le consultant confirme ou écarte d'un coup par processus,
 * ou une par une dans « Hypothèses à examiner ». Mission dédiée. `E2E_SCREENSHOT=1` écrit la
 * capture de la page remise au PO.
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

test.describe('cartographie : enchaînements des processus', () => {
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

  test('avant la validation du dossier, la page indique que la cartographie est verrouillée', async ({
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

    const nav = page.getByRole('navigation', { name: /mission/i });
    await nav.getByRole('link', { name: 'Cartographie' }).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/cartographie$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Cartographie' })).toBeVisible();
    await expect(
      page.getByText('La cartographie s’ouvre quand le client a validé le dossier d’analyse.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Construire tous les enchaînements' }),
    ).toHaveCount(0);
    // Critère : les routes de cartographie renvoient 409 PHASE_LOCKED.
    const locked = await page.request.get(`/api/missions/${missionId}/mapping/processes`);
    expect(locked.status()).toBe(409);
    expect(((await locked.json()) as { code: string }).code).toBe('PHASE_LOCKED');
    await expectNoSeriousViolations(page);
    await context.close();
  });

  test('le consultant soumet le dossier, le validateur le valide : la cartographie s’ouvre', async ({
    browser,
  }) => {
    const consultant = await browser.newContext();
    const consultantPage = await consultant.newPage();
    await loginAnyState(consultantPage, ACCOUNTS.consultantA);
    const submitted = await consultantPage.request.post(`/api/missions/${missionId}/submissions`, {
      headers: await csrf(consultantPage),
      data: { kind: 'analysis_dossier' },
    });
    expect(submitted.status(), await submitted.text()).toBe(201);
    const submissionId = ((await submitted.json()) as { id: string }).id;
    await consultant.close();

    const client = await browser.newContext();
    const validatorPage = await client.newPage();
    await loginAnyState(validatorPage, ACCOUNTS.validator);
    const validated = await validatorPage.request.post(
      `/api/missions/${missionId}/submissions/${submissionId}/validate`,
      { headers: await csrf(validatorPage), data: {} },
    );
    expect(validated.status(), await validated.text()).toBe(200);
    expect(((await validated.json()) as { phase: string }).phase).toBe('mapping');
    // Le validateur ne voit pas la cartographie (403) et sa navigation ne la propose pas.
    expect(
      (await validatorPage.request.get(`/api/missions/${missionId}/mapping/processes`)).status(),
    ).toBe(403);
    await validatorPage.goto(`/missions/${missionId}/cartographie`);
    await expect(
      validatorPage.getByText('La cartographie est réservée à l’équipe du cabinet.'),
    ).toBeVisible();
    await client.close();
  });

  test('construire P04, détailler « Relance des pièces manquantes », puis tous les processus', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await page.goto(`/missions/${missionId}/cartographie`);
    await expect(page.getByTestId('flow-summary')).toHaveText(
      '0 processus sur 45 ont un enchaînement.',
    );
    await expect(page.getByTestId('flow-macro')).toHaveCount(14);

    // Un processus : « Relances clients » (P04).
    const row = page.getByTestId('flow-row').filter({ hasText: 'Relances clients' });
    await expect(row).toContainText('À construire');
    await row.getByRole('button', { name: /^Construire l’enchaînement de/ }).click();
    await expect(row).toContainText('Construit : ', { timeout: 60_000 });
    await expect(row).toContainText('à examiner');
    await expect(row.getByTestId('flow-task')).toHaveCount(3);
    await expect(page.getByTestId('flow-summary')).toHaveText(
      '1 processus sur 45 ont un enchaînement.',
    );

    // Niveau 3 de l'exemple du CDC 4.1.
    const task = row.getByTestId('flow-task').filter({ hasText: 'Relance des pièces manquantes' });
    await task.getByRole('button', { name: /^Détailler la tâche/ }).click();
    await expect(task).toContainText('Niveau 3 construit', { timeout: 60_000 });
    await expect(task).toContainText('à examiner');
    await expectNoSeriousViolations(page);

    // Tous les autres processus : un lot, avec progression.
    await page.getByRole('button', { name: 'Construire tous les enchaînements' }).click();
    await expect(page.getByTestId('flow-summary')).toHaveText(
      '45 processus sur 45 ont un enchaînement.',
      { timeout: 120_000 },
    );
    await expect(
      page.getByRole('button', { name: 'Construire tous les enchaînements' }),
    ).toBeDisabled();
    await expect(page.getByTestId('flow-failure')).toHaveCount(0);

    // Les hypothèses sont à examiner dans l'espace Analyse (revue de WP-14 réutilisée).
    await page.getByRole('link', { name: 'Examiner les hypothèses une par une' }).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/analyse#hypotheses$`));
    const section = page.getByTestId('hypotheses-section');
    await expect(section.getByTestId('hypotheses-count')).not.toHaveText('(0)', {
      timeout: 15_000,
    });
    await expect(
      section
        .locator('[data-testid="hypothesis-card"][data-element-code^="EVT"]')
        .filter({ hasText: 'Pièces attendues du dossier' }),
    ).toBeVisible();
    await context.close();
  });

  test('décisions : confirmer tout un processus, écarter un autre, rejeter un nœud en cascade', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await page.goto(`/missions/${missionId}/cartographie`);
    const relances = page.getByTestId('flow-row').filter({ hasText: 'Relances clients' });
    await relances.getByRole('button', { name: /^Tout confirmer/ }).click();
    await expect(relances).toContainText('Tout est examiné', { timeout: 30_000 });
    await expect(page.getByTestId('flow-announcement')).toContainText('Hypothèses confirmées :');

    // Écarter l'enchaînement d'un autre processus : confirmation, puis retour à « À construire ».
    const creation = page.getByTestId('flow-row').filter({ hasText: 'Création des dossiers' });
    await creation.getByRole('button', { name: /^Tout écarter/ }).click();
    await expect(creation).toContainText('Écarter toutes les hypothèses en attente');
    await creation.getByRole('button', { name: 'Oui, tout écarter' }).click();
    await expect(creation).toContainText('À construire', { timeout: 30_000 });
    await expect(page.getByTestId('flow-announcement')).toContainText('Hypothèses écartées :');
    await expect(page.getByTestId('flow-summary')).toHaveText(
      '44 processus sur 45 ont un enchaînement.',
    );
    await expectNoSeriousViolations(page);

    // Rejeter un nœud dans l'espace Analyse retire en cascade les flux qui en dépendent.
    await page.goto(`/missions/${missionId}/analyse#hypotheses`);
    const section = page.getByTestId('hypotheses-section');
    const card = section
      .locator('[data-testid="hypothesis-card"][data-element-code^="EVT"]')
      .filter({ hasText: 'Début : Imputation' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    const before = await section.getByTestId('hypothesis-card').count();
    await card.getByRole('button', { name: /^Rejeter/ }).click();
    await card.getByRole('button', { name: 'Confirmer le rejet' }).click();
    await expect(section.getByTestId('hypothesis-card')).toHaveCount(before - 2, {
      timeout: 15_000,
    });
    await context.close();
  });

  test('capture de la page pour le PO', async ({ browser }) => {
    test.skip(!process.env['E2E_SCREENSHOT'], 'Capture demandée par E2E_SCREENSHOT=1.');
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await page.goto(`/missions/${missionId}/cartographie`);
    await expect(page.getByTestId('flow-summary')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: SCREENSHOT });
    await context.close();
  });
});
