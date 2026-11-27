import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, expectNoSeriousViolations, loginAnyState } from './support.js';

const dashboardChangeSet: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/dashboard-changeset.json', import.meta.url)),
    'utf8',
  ),
);

/**
 * Coédition (WP-10) : deux consultants dans deux contextes de navigateur distincts, un lecteur
 * sans droit d'écriture (administrateur, non membre) et le validateur, qui n'utilise pas Yjs.
 * Ce fichier passe après `shell.spec.ts` (qui enrôle consultante A et le validateur).
 */

const EDITOR_NAME = 'Description du métier du client';

async function missionId(page: Page): Promise<string> {
  const missions = (await (await page.request.get('/api/missions')).json()) as {
    id: string;
    name: string;
  }[];
  const pilot = missions.find((mission) => mission.name === 'Cabinet pilote');
  expect(pilot).toBeDefined();
  return pilot?.id as string;
}

async function openAnalysis(page: Page, id: string): Promise<void> {
  await page.goto(`/missions/${id}/analyse`);
  await expect(page.getByText('Coédition active')).toBeVisible({ timeout: 15_000 });
}

test.describe('coédition de la mission pilote', () => {
  // Les connexions attendent parfois le pas TOTP suivant (le serveur refuse le rejeu d'un code).
  test.setTimeout(120_000);

  test('deux consultants voient la présence de l’autre et se partagent le texte', async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await loginAnyState(pageA, ACCOUNTS.consultantA);
    await loginAnyState(pageB, ACCOUNTS.consultantB);
    const id = await missionId(pageA);

    await openAnalysis(pageA, id);
    await openAnalysis(pageB, id);

    // Présence : chacun voit l'autre (texte et alternative textuelle des avatars).
    await expect(pageA.getByText('Claude Consultant édite aussi cette mission.')).toBeVisible();
    await expect(pageB.getByText('Camille Consultante édite aussi cette mission.')).toBeVisible();
    const peopleA = pageA.getByRole('list', { name: 'Personnes connectées à cette mission' });
    await expect(peopleA.getByRole('listitem')).toHaveCount(2);
    await expect(peopleA).toContainText('Camille Consultante (vous)');
    await expect(peopleA).toContainText('Claude Consultant, connecté(e)');
    await expectNoSeriousViolations(pageA);
    await expectNoSeriousViolations(pageB);

    // Texte partagé : A écrit, B le voit ; B répond, A le voit.
    const editorA = pageA.getByRole('textbox', { name: EDITOR_NAME });
    const editorB = pageB.getByRole('textbox', { name: EDITOR_NAME });
    await editorA.click();
    await pageA.keyboard.type('Cabinet de comptabilité de douze personnes.');
    await expect(editorB).toContainText('Cabinet de comptabilité de douze personnes.', {
      timeout: 2000,
    });
    await editorB.click();
    await pageB.keyboard.press('Control+End');
    await pageB.keyboard.type(' Saisonnalité forte en mars.');
    await expect(editorA).toContainText('Saisonnalité forte en mars.', { timeout: 2000 });

    // La version du modèle est visible chez les deux ; un commit de l'un arrive chez l'autre.
    const me = await (await pageA.request.get('/api/me')).json();
    const csrf = me.csrfToken as string;
    const head = (await (await pageA.request.get(`/api/missions/${id}/model`)).json()) as {
      version: number;
      model: { elements: Record<string, unknown> };
    };
    let version = head.version;
    if (version === 0) {
      const first = await pageA.request.post(`/api/missions/${id}/model/changes`, {
        headers: { 'x-csrf-token': csrf },
        data: { changeSet: dashboardChangeSet },
      });
      expect(first.status(), await first.text()).toBe(201);
      version = 1;
    }
    await expect(pageB.getByTestId('model-version')).toContainText(`${version}`, {
      timeout: 2000,
    });
    const elementId = Object.keys(
      (
        (await (await pageA.request.get(`/api/missions/${id}/model`)).json()) as {
          model: { elements: Record<string, unknown> };
        }
      ).model.elements,
    )[0] as string;
    const started = Date.now();
    const commit = await pageA.request.post(`/api/missions/${id}/model/changes`, {
      headers: { 'x-csrf-token': csrf },
      data: {
        changeSet: {
          baseVersion: version,
          cause: 'dialogue_edit',
          summary: 'Mise à jour E2E',
          ops: [{ op: 'update', id: elementId, set: { label: 'Libellé modifié' } }],
        },
      },
    });
    expect(commit.status(), await commit.text()).toBe(201);
    await expect(pageB.getByTestId('model-version')).toContainText(`${version + 1}`, {
      timeout: 2000,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(pageA.getByTestId('model-version')).toContainText(`${version + 1}`);

    // Départ de B : A ne le voit plus.
    await contextB.close();
    await expect(pageA.getByText('Claude Consultant édite aussi cette mission.')).toHaveCount(0, {
      timeout: 15_000,
    });
    await contextA.close();
  });

  test('un lecteur sans droit d’écriture voit le texte mais ne peut pas le modifier', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.admin);
    const id = await missionId(page);
    await openAnalysis(page, id);

    const editor = page.getByRole('textbox', { name: EDITOR_NAME });
    await expect(editor).toContainText('Cabinet de comptabilité de douze personnes.');
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(editor).toHaveAttribute('aria-readonly', 'true');
    await expect(page.getByText('Vous consultez ce texte en lecture seule.')).toBeVisible();
    await editor.click();
    await page.keyboard.type('Texte non autorisé');
    await expect(editor).not.toContainText('Texte non autorisé');
    await expectNoSeriousViolations(page);
    await context.close();

    // La modification n'a pas non plus été enregistrée côté serveur : un consultant relit le texte.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await loginAnyState(otherPage, ACCOUNTS.consultantA);
    await openAnalysis(otherPage, id);
    await expect(otherPage.getByRole('textbox', { name: EDITOR_NAME })).not.toContainText(
      'Texte non autorisé',
    );
    await other.close();
  });

  test('le validateur n’utilise pas la coédition', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.validator);
    const id = await missionId(page);
    const token = await page.request.post(`/api/missions/${id}/collab-token`, {
      headers: {
        'x-csrf-token': (
          (await (await page.request.get('/api/me')).json()) as { csrfToken: string }
        ).csrfToken,
      },
      data: {},
    });
    expect(token.status()).toBe(403);
    await page.goto(`/missions/${id}/analyse`);
    await expect(page.getByText('Coédition indisponible pour votre profil').first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: EDITOR_NAME })).toHaveCount(0);
    await expectNoSeriousViolations(page);
    await context.close();
  });
});
