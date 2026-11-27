import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  PILOT_ANSWER_ENVIRONMENT,
  PILOT_ANSWER_IMPUTATION,
  PILOT_ANSWER_SAISIE,
  PILOT_DESCRIPTION,
  PILOT_QUESTION_ENVIRONMENT,
} from '@processia/test-fixtures';
import { ACCOUNTS, expectNoSeriousViolations, loginAnyState } from './support.js';

const SCREENSHOT = fileURLToPath(
  new URL('../../docs/wp/WP-14-questionnement.png', import.meta.url),
);
const EDITOR_NAME = 'Description du métier du client';
const MISSION_NAME = 'Questionnement E2E du pilote';

/**
 * Questionnement guidé et hypothèses (WP-14) sur le scénario factice du pilote : questions
 * classées (la plus bloquante d'abord), trois réponses qui font monter la complétude, arrêt du
 * questionnement, hypothèses acceptées, corrigées et rejetées (jamais reproposées), « Confirmer »
 * d'un élément extrait, second consultant qui voit les décisions sans recharger. Mission dédiée.
 * `E2E_SCREENSHOT=1` écrit aussi la capture remise au PO (`docs/wp/WP-14-questionnement.png`).
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

/** Pourcentage de complétude affiché dans le panneau des questions. */
async function completenessPercent(section: Locator): Promise<number> {
  const text = (await section.getByTestId('questions-completeness').textContent()) ?? '';
  const match = /(\d+) %/.exec(text);
  expect(match, text).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

const card = (page: Page, label: string): Locator =>
  page.getByTestId('hypothesis-card').filter({ hasText: label });

test.describe('questionnement guidé du pilote', () => {
  test.setTimeout(300_000);

  test('mission dédiée avec deux consultants', async ({ browser }) => {
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

  test('questions classées, trois réponses, complétude en hausse, arrêt du questionnement', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openAnalysis(page);
    await paste(page, PILOT_DESCRIPTION);
    await page.getByRole('button', { name: 'Analyser', exact: true }).click();
    await expect(page.getByText('Analyse terminée')).toBeVisible({ timeout: 60_000 });

    const section = page.getByTestId('questions-section');
    await expect(section.getByTestId('questions-empty')).toContainText('Aucune question');
    await expectNoSeriousViolations(page);

    // La première question est la plus bloquante : l'environnement du métier.
    await section.getByRole('button', { name: 'Préparer des questions' }).click();
    await expect(page.getByText('Questions prêtes')).toBeVisible({ timeout: 30_000 });
    const current = section.getByTestId('current-question');
    await expect(current).toContainText(PILOT_QUESTION_ENVIRONMENT);
    await expect(section.getByTestId('question-blocking')).toContainText('Bloquant pour : Métier');
    await expect(section.getByTestId('question-blocking')).toContainText('effet bloquant 92');
    await expect(section.getByTestId('questions-count')).toContainText(/\(\d+ ouverte\(s\)\)/);
    await expect(current.getByRole('button', { name: 'Répondre' })).toBeDisabled();
    await expectNoSeriousViolations(page);

    // Trois réponses : chacune crée une source `answer` et fait monter la complétude.
    const answers: [string, string][] = [
      [PILOT_ANSWER_ENVIRONMENT, 'Environnement réglementaire'],
      [PILOT_ANSWER_SAISIE, 'Saisie'],
      [PILOT_ANSWER_IMPUTATION, 'Imputation'],
    ];
    const initial = await completenessPercent(section);
    let previous = initial;
    for (const [index, [text, expected]] of answers.entries()) {
      if (index > 0) await expect(current).toContainText(expected);
      await current.getByLabel('Votre réponse').fill(text);
      await current.getByRole('button', { name: 'Répondre' }).click();
      await expect(page.getByText('Réponse intégrée').first()).toBeVisible({ timeout: 30_000 });
      // Le modèle passe à la version suivante (1 = analyse, puis une version par réponse).
      await expect(page.getByTestId('model-version')).toContainText(String(index + 2), {
        timeout: 15_000,
      });
      const now = await completenessPercent(section);
      // L'environnement du métier fait monter la complétude d'au moins trois points ; les tâches
      // d'un processus l'augmentent aussi, d'un demi-point ou plus (l'affichage est arrondi).
      if (index === 0) expect(now).toBeGreaterThan(previous);
      else expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
      if (index === answers.length - 1) expect(now).toBeGreaterThan(initial);
      // La question suivante est affichée, la précédente est « traitée ».
      await expect(section.getByTestId('questions-treated')).toContainText(
        `Questions traitées (${index + 1})`,
      );
    }
    await expect(page.getByTestId('model-version')).toContainText('4');

    // Les réponses sont des sources citées par les éléments qu'elles ont créés.
    const sources = page.getByRole('list', { name: 'Sources de la mission' });
    await expect(sources.getByText(/Réponse : /)).toHaveCount(3);
    await page.getByRole('tab', { name: /^Activités \(\d+\)/ }).click();
    await page.locator('.element-row').filter({ hasText: 'Réception des pièces' }).click();
    const fiche = page.getByTestId('fiche');
    await expect(fiche).toContainText('Extrait');
    await expect(fiche).toContainText('Réponse à une question');
    await expect(fiche.locator('.citation-quote').first()).toHaveText('la réception des pièces');
    await expectNoSeriousViolations(page);

    // Tableau de bord : « À faire » mène aux questions.
    await page.goto(`/missions/${missionId}`);
    await page.getByRole('link', { name: /question\(s\) ouverte\(s\)/ }).click();
    await expect(page).toHaveURL(/\/analyse#questions$/);
    await expect(page.getByRole('heading', { name: /^Questions de l’outil/ })).toBeInViewport();

    // « Passer » puis « Arrêter les questions » : plus aucune question ouverte.
    await expect(page.getByText('Coédition active')).toBeVisible({ timeout: 15_000 });
    const again = page.getByTestId('questions-section');
    await again.getByRole('button', { name: 'Passer' }).click();
    await expect(again.getByTestId('questions-treated')).toContainText('Questions traitées (4)');
    await again.getByRole('button', { name: 'Arrêter les questions' }).click();
    await expect(again.getByText('Le questionnement est arrêté')).toBeVisible();
    await expect(again.getByTestId('current-question')).toHaveCount(0);
    await expect(again.getByTestId('questions-count')).toContainText('(0 ouverte(s))');
    await expectNoSeriousViolations(page);
    await context.close();
  });

  test('hypothèses : accepter, corriger, rejeter ; jamais reproposée ; second consultant', async ({
    browser,
  }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await loginAnyState(pageA, ACCOUNTS.consultantA);
    await loginAnyState(pageB, ACCOUNTS.consultantB);
    await openAnalysis(pageA);
    await openAnalysis(pageB);

    const section = pageA.getByTestId('hypotheses-section');
    await expect(section.getByTestId('hypotheses-empty')).toBeVisible();
    await section.getByRole('button', { name: 'Proposer des hypothèses' }).click();
    await expect(pageA.getByText('Propositions prêtes')).toBeVisible({ timeout: 30_000 });
    await expect(section.getByTestId('hypotheses-count')).toHaveText('(5)');
    await expect(pageB.getByTestId('hypotheses-count')).toHaveText('(5)');

    // Chaque carte affiche la nature, l'origine, la justification et trois actions.
    const liasse = card(pageA, 'Liasse fiscale');
    await expect(liasse).toContainText('Terme du glossaire');
    await expect(liasse).toContainText('Connaissance générale de l’outil');
    await expect(liasse).toContainText('Pourquoi');
    await expect(liasse.getByRole('button', { name: /^Accepter/ })).toBeVisible();
    await expect(liasse.getByRole('button', { name: /^Corriger/ })).toBeVisible();
    await expect(liasse.getByRole('button', { name: /^Rejeter/ })).toBeVisible();
    await expectNoSeriousViolations(pageA);
    if (process.env['E2E_SCREENSHOT']) {
      await pageA.screenshot({ path: SCREENSHOT, fullPage: true });
    }

    // Accepter : l'hypothèse devient confirmée ; B le voit sans recharger.
    await liasse.getByRole('button', { name: /^Accepter/ }).click();
    await expect(section.getByTestId('hypotheses-announcement')).toContainText(
      '« Liasse fiscale » est confirmée.',
    );
    await expect(section.getByTestId('hypotheses-count')).toHaveText('(4)');
    await expect(pageB.getByTestId('hypotheses-count')).toHaveText('(4)', { timeout: 5000 });
    await expect(card(pageB, 'Liasse fiscale')).toHaveCount(0);

    // Corriger : petit formulaire sur les textes ; l'ancienne valeur est conservée par le modèle.
    const season = card(pageA, 'Saisonnalité de l’activité');
    await season.getByRole('button', { name: /^Corriger/ }).click();
    const form = season.getByRole('form', { name: /^Correction de l’hypothèse/ });
    await expect(form).toBeVisible();
    await expectNoSeriousViolations(pageA);
    await form.getByLabel('Texte').fill('Pic de charge de mars à mai');
    await form.getByRole('button', { name: 'Enregistrer la correction' }).click();
    await expect(section.getByTestId('hypotheses-count')).toHaveText('(3)');

    // Rejeter : retirée du modèle et archivée, avec le motif.
    const ged = card(pageA, 'Logiciel de GED');
    await ged.getByRole('button', { name: /^Rejeter/ }).click();
    await ged.getByLabel('Motif du rejet (facultatif)').fill('Pas de GED au cabinet');
    await ged.getByRole('button', { name: 'Confirmer le rejet' }).click();
    await expect(section.getByTestId('hypotheses-count')).toHaveText('(2)');
    const archive = section.getByTestId('hypotheses-archive');
    await expect(archive).toContainText('Hypothèses rejetées (1)');
    await archive.locator('summary').click();
    await expect(archive).toContainText('Logiciel de GED');
    await expect(archive).toContainText('motif : Pas de GED au cabinet');
    await expectNoSeriousViolations(pageA);

    // Relancer : l'hypothèse rejetée n'est pas reproposée et le modèle ne change pas.
    await section.getByRole('button', { name: 'Proposer des hypothèses' }).click();
    await expect(pageA.getByText('Aucune nouvelle hypothèse')).toBeVisible({ timeout: 30_000 });
    await expect(section.getByTestId('hypotheses-count')).toHaveText('(2)');
    await expect(card(pageA, 'Logiciel de GED')).toHaveCount(0);

    // Le second consultant décide à son tour : l'autre carte disparaît chez A sans recharger.
    await card(pageB, 'Commissaire aux comptes')
      .getByRole('button', { name: /^Accepter/ })
      .click();
    await expect(pageA.getByTestId('hypotheses-count')).toHaveText('(1)', { timeout: 5000 });
    await expect(card(pageA, 'Commissaire aux comptes')).toHaveCount(0);

    // Synthèse du métier : proposée comme hypothèse à confirmer.
    await section.getByRole('button', { name: 'Proposer une synthèse du métier' }).click();
    await expect(pageA.getByText('Synthèse proposée')).toBeVisible({ timeout: 30_000 });
    const summary = card(pageA, 'Synthèse du métier');
    await expect(summary).toContainText('Trait du métier');
    await expect(summary).toContainText('Pourquoi');
    await summary.getByRole('button', { name: /^Accepter/ }).click();
    await expect(section.getByTestId('hypotheses-announcement')).toContainText(
      '« Synthèse du métier » est confirmée.',
    );
    await contextA.close();
    await contextB.close();
  });

  test('« Confirmer » un élément extrait depuis sa fiche ; lien du tableau de bord', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await openAnalysis(page);

    await page.getByRole('tab', { name: /^Activités \(\d+\)/ }).click();
    await page.locator('.element-row').filter({ hasText: 'P01' }).first().click();
    const fiche = page.getByTestId('fiche');
    await expect(fiche).toContainText('Extrait');
    await fiche.getByRole('button', { name: /^Confirmer l’élément/ }).click();
    await expect(page.getByText('Élément confirmé', { exact: true })).toBeVisible();
    await expect(fiche).toContainText('Confirmé');
    await expect(fiche.getByRole('button', { name: /^Confirmer l’élément/ })).toHaveCount(0);
    await expect(fiche).toContainText('Décidé le');
    await expectNoSeriousViolations(page);

    // Une hypothèse confirmée n'est plus à examiner ; le tableau de bord ne la compte plus.
    await page.goto(`/missions/${missionId}`);
    await expect(
      page.getByText('Cabinet pilote').or(page.getByText(MISSION_NAME)).first(),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /hypothèse\(s\) à examiner/ })).toHaveCount(0);
    await context.close();
  });
});
