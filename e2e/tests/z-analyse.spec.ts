import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { PILOT_CONTRADICTORY_DOCUMENT, PILOT_DESCRIPTION } from '@processia/test-fixtures';
import { ACCOUNTS, expectNoSeriousViolations, loginAnyState } from './support.js';

const SCREENSHOT = fileURLToPath(new URL('../../docs/wp/WP-13-analyse.png', import.meta.url));
const EDITOR_NAME = 'Description du métier du client';
const MISSION_NAME = 'Analyse E2E du pilote';

/**
 * Espace « Analyse » (WP-13) sur le scénario factice du pilote : description du CDC 8 collée,
 * « Analyser » (worker pg-boss réel), éléments avec leurs citations, complétude des sept concepts,
 * second consultant qui voit la nouvelle version sans recharger, document contradictoire déposé,
 * historique et retour arrière. Une mission dédiée évite de dépendre des autres parcours.
 * `E2E_SCREENSHOT=1` écrit aussi la capture remise au PO (`docs/wp/WP-13-analyse.png`).
 */
test.describe.configure({ mode: 'serial' });

let missionId = '';

async function csrf(page: Page): Promise<string> {
  const me = (await (await page.request.get('/api/me')).json()) as { csrfToken: string };
  return me.csrfToken;
}

async function openAnalysis(page: Page): Promise<void> {
  await page.goto(`/missions/${missionId}/analyse`);
  await expect(page.getByText('Coédition active')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('textbox', { name: EDITOR_NAME })).toBeVisible();
}

/** Colle du texte brut dans l'éditeur (paragraphes séparés par une ligne vide). */
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

test.describe('espace Analyse du pilote', () => {
  test.setTimeout(240_000);

  test('mission dédiée avec deux consultants', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.manager);
    const token = await csrf(page);
    const headers = { 'x-csrf-token': token };

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
    for (const email of [ACCOUNTS.consultantA, ACCOUNTS.consultantB]) {
      const user = assignable.find((candidate) => candidate.email === email);
      expect(user, email).toBeDefined();
      const assigned = await page.request.put(`/api/missions/${missionId}/members`, {
        headers,
        data: { userId: user?.id, missionRole: 'consultant' },
      });
      expect(assigned.status(), await assigned.text()).toBe(200);
    }
    await context.close();
  });

  test('description, « Analyser », éléments cités, complétude, second consultant', async ({
    browser,
  }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await loginAnyState(pageA, ACCOUNTS.consultantA);
    await loginAnyState(pageB, ACCOUNTS.consultantB);
    await openAnalysis(pageA);
    await openAnalysis(pageB);

    // État initial : aucun modèle, pas encore de source ; l'analyse d'une description vide est refusée.
    await expect(pageA.getByRole('heading', { level: 1, name: 'Analyse du métier' })).toBeVisible();
    await expect(pageA.getByText('Le modèle est vide pour le moment.')).toBeVisible();
    await expect(pageA.getByText('Aucune source pour le moment.')).toBeVisible();
    await pageA.getByRole('button', { name: 'Analyser', exact: true }).click();
    await expect(pageA.getByText('La description du métier est vide')).toBeVisible();
    await expectNoSeriousViolations(pageA);

    // Le texte collé par A (paragraphes du CDC 8) arrive chez B, puis A lance « Analyser ».
    await paste(pageA, PILOT_DESCRIPTION);
    await expect(pageB.getByRole('textbox', { name: EDITOR_NAME })).toContainText(
      'Notes du consultant',
      { timeout: 5000 },
    );
    await pageA.getByRole('button', { name: 'Analyser', exact: true }).click();
    await expect(pageA.getByText('Analyse terminée')).toBeVisible({ timeout: 60_000 });

    // B voit la nouvelle version sans recharger la page, et la source figée.
    await expect(pageB.getByTestId('model-version')).toContainText('1', { timeout: 5000 });
    await expect(pageB.getByRole('tab', { name: /^Acteurs \(\d+\)/ })).toBeVisible();
    await expect(
      pageB.getByRole('list', { name: 'Sources de la mission' }).getByRole('listitem'),
    ).toHaveCount(1);
    await expect(pageB.getByText('Description du métier, révision 1')).toBeVisible();

    // 14 macroprocessus P01 à P14, avec leur statut (texte et icône).
    await pageA.getByRole('tab', { name: /^Activités \(\d+\)/ }).click();
    const codes = pageA.locator('.element-code').filter({ hasText: /^P\d\d$/ });
    await expect(codes).toHaveCount(14);
    await expect(codes.first()).toHaveText('P01');
    await expect(codes.last()).toHaveText('P14');
    const firstRow = pageA.locator('.element-row').first();
    await expect(firstRow).toContainText('Extrait');

    // 8 acteurs internes du CDC 8.3 (plus les parties prenantes externes).
    await pageA.getByRole('tab', { name: /^Acteurs \(\d+\)/ }).click();
    const actors = pageA.getByRole('list', { name: 'Éléments : Acteurs' }).getByRole('listitem');
    expect(await actors.count()).toBeGreaterThanOrEqual(8);

    // La fiche d'un macroprocessus porte une citation qui ouvre la source surlignée.
    await pageA.getByRole('tab', { name: /^Activités \(\d+\)/ }).click();
    await pageA.locator('.element-row').filter({ hasText: 'P01' }).first().click();
    const fiche = pageA.getByTestId('fiche');
    await expect(fiche).toContainText('Extrait');
    await expect(fiche).toContainText('Description du métier');
    const quote = (await fiche.locator('.citation-quote').first().textContent()) ?? '';
    expect(quote.length).toBeGreaterThan(10);
    await fiche
      .getByRole('button', { name: /^Voir dans la source/ })
      .first()
      .click();
    const dialog = pageA.getByRole('dialog', { name: /^Source : Description du métier/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('viewer-highlight')).toHaveText(quote);
    await expectNoSeriousViolations(pageA);
    await pageA.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Complétude affichée pour les sept concepts, avec la liste des manques.
    const concepts = [
      ['Métier', 'business'],
      ['Acteurs', 'actors'],
      ['Activités', 'activities'],
      ['Données', 'data'],
      ['Flux', 'flows'],
      ['Règles', 'rules'],
      ['Indicateurs', 'indicators'],
    ] as const;
    for (const [name, id] of concepts) {
      await pageA.getByRole('tab', { name: new RegExp(`^${name} \\(\\d+\\)`) }).click();
      await expect(pageA.getByTestId(`completeness-${id}`)).toContainText(/Complétude : \d+ %/);
      await expect(
        pageA.getByRole('progressbar', { name: `Complétude du concept ${name}` }),
      ).toBeVisible();
    }
    await expect(pageA.getByTestId('completeness-flows')).toBeHidden();
    await pageA.getByRole('tab', { name: /^Flux/ }).click();
    await expect(pageA.getByText('Ce qui manque')).toBeVisible();

    // Présence : B voit la vue consultée par A.
    await expect(
      pageB.getByRole('list', { name: 'Personnes connectées à cette mission' }),
    ).toContainText(/Camille Consultante, connecté\(e\), consulte : Analyse, Flux/);

    // Capture pour le PO : l'espace Analyse après l'extraction du pilote.
    await pageA.getByRole('tab', { name: /^Activités/ }).click();
    await pageA.locator('.element-row').filter({ hasText: 'P04' }).first().click();
    await expectNoSeriousViolations(pageA);
    await expect(pageA.getByText('La description du métier est vide')).toBeHidden({
      timeout: 15_000,
    });
    if (process.env['E2E_SCREENSHOT']) {
      await pageA.screenshot({ path: SCREENSHOT, fullPage: true });
    }
    await contextA.close();
    await contextB.close();
  });

  test('document contradictoire, écart visible, liens du tableau de bord', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openAnalysis(page);

    await page.getByTestId('source-upload').setInputFiles({
      name: 'note-organisation.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(PILOT_CONTRADICTORY_DOCUMENT, 'utf8'),
    });
    const item = page.getByTestId('source-item').filter({ hasText: 'note-organisation.txt' });
    await expect(item).toContainText('Texte lu, prêt à analyser', { timeout: 30_000 });
    await item
      .getByRole('button', { name: /^Analyser ce document : note-organisation.txt/ })
      .click();
    await expect(page.getByText('Analyse terminée')).toBeVisible({ timeout: 60_000 });

    // La contradiction est visible dans les sources, avec ses deux versions.
    const notice = page.getByTestId('contradiction');
    await expect(notice).toContainText('Contradiction entre sources');
    await expect(notice).toContainText('Assistant administratif');
    await expect(notice).toContainText('Collaborateur comptable');
    await expect(item).toContainText('élément(s) citent cette source');
    await expectNoSeriousViolations(page);

    await notice.getByRole('button', { name: 'Voir l’écart' }).click();
    await expect(page.getByRole('tab', { name: /^Écarts \(1\)/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.locator('.element-row').first().click();
    const fiche = page.getByTestId('fiche');
    await expect(fiche).toContainText('Écart entre sources');
    await expect(fiche).toContainText('Version 1');
    await expect(fiche).toContainText('Version 2');
    await fiche
      .getByRole('button', { name: /^Voir dans la source/ })
      .last()
      .click();
    const dialog = page.getByRole('dialog', { name: /^Source : note-organisation.txt/ });
    await expect(dialog.getByTestId('viewer-highlight')).toContainText('collaborateur comptable');
    await page.keyboard.press('Escape');

    // Tableau de bord : « À faire » mène aux écarts.
    await page.goto(`/missions/${missionId}`);
    await page.getByRole('link', { name: /contradiction\(s\) entre deux sources/ }).click();
    await expect(page).toHaveURL(/\/analyse#contradictions$/);
    await expect(page.getByRole('tab', { name: /^Écarts/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await context.close();
  });

  test('historique des versions et retour arrière', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openAnalysis(page);

    const versions = page.getByTestId('version-item');
    await expect(versions).toHaveCount(2);
    await expect(versions.first()).toContainText('Version 2');
    await expect(versions.first()).toContainText('version actuelle');
    await expect(versions.last()).toContainText('Analyse des sources');

    // Différences de la version 2 : l'écart ajouté, une activité modifiée.
    await versions.first().getByRole('button', { name: 'Voir les changements' }).click();
    await expect(versions.first().getByRole('group', { name: /^Changements/ })).toContainText(
      '1 ajouté(s)',
    );
    await expectNoSeriousViolations(page);

    // Retour arrière à la version 1 : une version 3 est créée, rien n'est supprimé.
    await versions
      .last()
      .getByRole('button', { name: 'Revenir à cette version, version 1' })
      .click();
    const confirm = page.getByRole('dialog', { name: 'Revenir à la version 1 ?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Créer la version de retour' }).click();
    await expect(page.getByText('Retour arrière effectué')).toBeVisible();
    await expect(versions).toHaveCount(3);
    await expect(versions.first()).toContainText('Version 3');
    await expect(versions.first()).toContainText('Retour arrière');
    await expect(page.getByTestId('model-version')).toContainText('3');
    // L'écart n'existe plus dans la version 3 (contenu de la version 1).
    await expect(page.getByRole('tab', { name: /^Écarts \(0\)/ })).toBeVisible();
    await expect(page.getByTestId('contradiction')).toHaveCount(0);
    await expectNoSeriousViolations(page);
    await context.close();
  });
});
