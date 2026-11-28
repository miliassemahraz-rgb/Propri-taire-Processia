import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { PILOT_DESCRIPTION } from '@processia/test-fixtures';
import { ACCOUNTS, expectNoSeriousViolations, loginAnyState } from './support.js';

const SCREENSHOT = fileURLToPath(new URL('../../docs/wp/WP-20-dialogue.png', import.meta.url));
const EDITOR_NAME = 'Description du métier du client';
const MISSION_NAME = 'Dialogue E2E du pilote';
const CONTROL = 'Contrôle des écritures';
const INSTRUCTION = 'ajoute une validation par le chef de mission après la révision';
const VALIDATION = 'Validation par le chef de mission';

/**
 * Modification par dialogue (WP-20) : sur le pilote enchaîné, un consultant demande une
 * modification en langage naturel, lit l'aperçu avant/après, l'applique, puis revient en arrière ;
 * deux consultants qui modifient le même élément déclenchent l'état `stale`. Mission dédiée.
 * `E2E_SCREENSHOT=1` écrit la capture remise au PO.
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

async function headVersion(page: Page): Promise<number> {
  const res = await page.request.get(`/api/missions/${missionId}/model`);
  return ((await res.json()) as { version: number }).version;
}

/** Ouvre la cartographie au niveau 2 de « Contrôle des écritures » (L0, P06, le processus). */
async function openControl(page: Page): Promise<void> {
  await page.goto(`/missions/${missionId}/cartographie`);
  await expect(page.getByTestId('mapping-viewer')).toBeVisible({ timeout: 30_000 });
  await page
    .locator('[data-testid="simple-card"][data-element-code="P06"]')
    .locator('xpath=ancestor::li[1]')
    .getByRole('button', { name: /^Ouvrir le niveau inférieur de/ })
    .click();
  await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L1:/);
  await page
    .getByTestId('simple-card')
    .filter({ hasText: CONTROL })
    .locator('xpath=ancestor::li[1]')
    .getByRole('button', { name: /^Ouvrir le niveau inférieur de/ })
    .click();
  await expect(page.getByTestId('mapping-viewer')).toHaveAttribute('data-diagram', /^L2:/);
  await expect(page.getByTestId('dialogue-panel')).toBeVisible();
  await expect(page.getByText('Coédition active')).toBeVisible({ timeout: 15_000 });
}

async function ask(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Nouvelle demande' }).fill(text);
  await page.getByTestId('dialogue-send').click();
}

const lastProposal = (page: Page) => page.getByTestId('proposal').last();

test.describe('cartographie : modification par dialogue', () => {
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

  test('préparation : analyse, validation du dossier, enchaînement du processus visé', async ({
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

    const overview = (await (
      await page.request.get(`/api/missions/${missionId}/mapping/processes`)
    ).json()) as { processes: { id: string; label: string }[] };
    const processIds = [CONTROL, 'Traitement des anomalies', 'Régularisation'].map(
      (label) => overview.processes.find((p) => p.label === label)?.id ?? '',
    );
    expect(processIds.every((id) => id !== '')).toBe(true);
    const started = await page.request.post(`/api/missions/${missionId}/mapping/flows`, {
      headers: await csrf(page),
      data: { processIds },
    });
    expect(started.status(), await started.text()).toBe(201);
    await waitRun(page, ((await started.json()) as { runId: string }).runId);
    await context.close();
  });

  test('critères 1 et 5 : l’aperçu montre la tâche dans le couloir et les enchaînements ; « Appliquer » crée la version N+1', async ({
    browser,
  }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await loginAnyState(pageA, ACCOUNTS.consultantA);
    await loginAnyState(pageB, ACCOUNTS.consultantB);
    await openControl(pageA);
    await openControl(pageB);
    const before = await headVersion(pageA);
    const cardsBefore = await pageA.getByTestId('simple-card').count();

    await ask(pageA, INSTRUCTION);
    const proposal = lastProposal(pageA);
    await expect(proposal).toBeVisible({ timeout: 30_000 });
    await expect(proposal).toHaveAttribute('data-status', 'pending');

    // Texte des différences : une tâche ajoutée et des enchaînements modifiés.
    const changes = proposal.getByTestId('proposal-changes');
    await expect(changes).toContainText('Ajout : tâche');
    await expect(changes).toContainText(VALIDATION);
    await expect(changes).toContainText('Enchaînement modifié');
    await expect(changes).toContainText('Enchaînement ajouté');
    await expect(proposal.getByTestId('proposal-warnings')).toContainText(
      'aucune incohérence créée',
    );

    // Diagrammes avant et après, avec leurs marqueurs en texte.
    const after = pageA.getByTestId('preview-after');
    await expect(after).toBeVisible();
    const lane = after
      .getByTestId('simple-lane')
      .filter({ has: pageA.locator('h3', { hasText: 'Chef de mission' }) });
    const added = lane.locator('[data-testid="simple-card"][data-change="added"]');
    await expect(added).toHaveCount(1);
    await expect(added).toContainText(VALIDATION);
    await expect(added).toContainText('Ajouté');
    await expect(
      after.locator('[data-testid="simple-card"][data-change="modified"]').first(),
    ).toContainText('Modifié');
    const beforeView = pageA.getByTestId('preview-before');
    await expect(beforeView.getByTestId('simple-card')).toHaveCount(cardsBefore);
    await expect(beforeView.locator('[data-change="added"]')).toHaveCount(0);
    await expectNoSeriousViolations(pageA);
    if (process.env['E2E_SCREENSHOT']) {
      await pageA.evaluate(() => window.scrollTo(0, 0));
      await pageA.screenshot({ path: SCREENSHOT, fullPage: true });
    }

    // Critère 5 : rien n'est enregistré avant « Appliquer ».
    expect(await headVersion(pageA)).toBe(before);
    await expect(pageB.getByTestId('simple-card').filter({ hasText: VALIDATION })).toHaveCount(0);

    // Les deux consultants voient la proposition ; seul « Appliquer » écrit une version.
    await expect(pageB.getByTestId('proposal').last()).toBeVisible({ timeout: 10_000 });
    await proposal.getByTestId('proposal-apply').click();
    await expect(proposal).toHaveAttribute('data-status', 'applied', { timeout: 15_000 });
    await expect(proposal.getByTestId('proposal-applied')).toContainText(
      `Version ${before + 1} enregistrée`,
    );
    expect(await headVersion(pageA)).toBe(before + 1);

    // Le niveau 2 est redessiné : la carte est dans le couloir, sans aperçu.
    await expect(pageA.getByTestId('preview-pair')).toHaveCount(0);
    const card = pageA
      .getByTestId('simple-lane')
      .filter({ has: pageA.locator('h3', { hasText: 'Chef de mission' }) })
      .getByTestId('simple-card')
      .filter({ hasText: VALIDATION });
    await expect(card).toHaveCount(1);
    expect(await pageA.getByTestId('simple-card').count()).toBe(cardsBefore + 1);
    // L'autre consultant voit le redessin sans recharger.
    await expect(pageB.getByTestId('simple-card').filter({ hasText: VALIDATION })).toHaveCount(1, {
      timeout: 5_000,
    });
    await contextA.close();
    await contextB.close();
  });

  test('critère 4 : le retour arrière restaure le diagramme précédent', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openControl(page);
    const version = await headVersion(page);
    const cards = await page.getByTestId('simple-card').count();
    await expect(page.getByTestId('simple-card').filter({ hasText: VALIDATION })).toHaveCount(1);

    // Depuis le dialogue : « Revenir à la version N-1 ».
    const applied = page.locator('[data-testid="proposal"][data-status="applied"]').last();
    await applied.getByTestId('proposal-undo').click();
    await expect(page.getByTestId('simple-card').filter({ hasText: VALIDATION })).toHaveCount(0, {
      timeout: 15_000,
    });
    expect(await page.getByTestId('simple-card').count()).toBe(cards - 1);
    expect(await headVersion(page)).toBe(version + 1);

    // L'historique de la cartographie montre le retour arrière (nouvelle version).
    const history = page.getByRole('region', { name: 'Historique des versions' });
    await expect(history.getByTestId('version-item').first()).toContainText('Retour arrière');
    await context.close();
  });

  test('critère 2 : une tâche sans responsable affiche ACTIVITY_WITHOUT_OWNER, puis « Abandonner »', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openControl(page);
    const version = await headVersion(page);
    await ask(page, 'ajoute une étape « Pointage de fin de journée » après la préparation');
    const proposal = lastProposal(page);
    await expect(proposal).toHaveAttribute('data-status', 'pending', { timeout: 30_000 });
    await expect(
      proposal.locator('[data-testid="warning"][data-code="ACTIVITY_WITHOUT_OWNER"]'),
    ).toBeVisible();
    await expect(proposal.getByTestId('proposal-warnings')).toContainText(
      'Incohérences créées par cette modification',
    );
    await expectNoSeriousViolations(page);
    await proposal.getByTestId('proposal-discard').click();
    await expect(proposal).toHaveAttribute('data-status', 'discarded');
    await expect(page.getByTestId('preview-pair')).toHaveCount(0);
    expect(await headVersion(page)).toBe(version);
    await context.close();
  });

  test('une consigne incomplète donne une question ; la réponse prépare la proposition', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openControl(page);
    await ask(page, 'ajoute une validation par le chef de mission');
    const question = page.getByTestId('dialogue-message').last();
    await expect(question).toContainText('À quel endroit', { timeout: 30_000 });
    await expect(question.getByTestId('proposal')).toHaveCount(0);
    await ask(page, 'après la préparation');
    const proposal = lastProposal(page);
    await expect(proposal).toHaveAttribute('data-status', 'pending', { timeout: 30_000 });
    await proposal.getByTestId('proposal-discard').click();
    await expect(proposal).toHaveAttribute('data-status', 'discarded');
    await context.close();
  });

  test('critère 3 : le second consultant reçoit « Périmée », puis régénère sur la version actuelle', async ({
    browser,
  }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await loginAnyState(pageA, ACCOUNTS.consultantA);
    await loginAnyState(pageB, ACCOUNTS.consultantB);
    await openControl(pageA);
    await openControl(pageB);

    await ask(pageA, 'ajoute une étape « Relecture croisée A » après la préparation');
    const pendingA = pageA.locator('[data-testid="proposal"][data-status="pending"]').last();
    await expect(pendingA).toBeVisible({ timeout: 30_000 });
    const idA = (await pendingA.getAttribute('data-proposal-id')) ?? '';
    const proposalA = pageA.locator(`[data-proposal-id="${idA}"]`);
    await ask(pageB, 'ajoute une étape « Relecture croisée B » après la préparation');
    // Le fil est commun : B voit la proposition de A, puis la sienne.
    const pendingAll = pageB.locator('[data-testid="proposal"][data-status="pending"]');
    await expect(pendingAll).toHaveCount(2, { timeout: 30_000 });
    const pendingB = pendingAll.last();
    const idB = (await pendingB.getAttribute('data-proposal-id')) ?? '';
    expect(idB).not.toBe(idA);

    // A applique : la proposition de B touche les mêmes enchaînements, elle devient périmée.
    await proposalA.getByTestId('proposal-apply').click();
    await expect(proposalA).toHaveAttribute('data-status', 'applied', { timeout: 15_000 });
    const stale = pageB.locator(`[data-proposal-id="${idB}"]`);
    await expect(stale).toHaveAttribute('data-status', 'stale', { timeout: 15_000 });
    await expect(stale).toContainText('Périmée');
    await expect(stale.getByTestId('proposal-apply')).toHaveCount(0);

    // « Régénérer » relance le pipeline sur la version actuelle.
    const head = await headVersion(pageB);
    await stale.getByTestId('proposal-regenerate').click();
    const fresh = pageB.locator('[data-testid="proposal"][data-status="pending"]').last();
    await expect(fresh).toBeVisible({ timeout: 30_000 });
    expect(await fresh.getAttribute('data-proposal-id')).not.toBe(idB);
    const freshId = (await fresh.getAttribute('data-proposal-id')) ?? '';
    await fresh.getByTestId('proposal-apply').click();
    await expect(pageB.locator(`[data-proposal-id="${freshId}"]`)).toHaveAttribute(
      'data-status',
      'applied',
      { timeout: 15_000 },
    );
    expect(await headVersion(pageB)).toBe(head + 1);
    await expectNoSeriousViolations(pageB);
    await contextA.close();
    await contextB.close();
  });
});
