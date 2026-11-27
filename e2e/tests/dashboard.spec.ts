import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ACCOUNTS, expectNoSeriousViolations, loginAndEnroll } from './support.js';

const changeSet: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/dashboard-changeset.json', import.meta.url)),
    'utf8',
  ),
);
const SCREENSHOT = fileURLToPath(new URL('../../docs/wp/WP-07-dashboard.png', import.meta.url));

/**
 * Tableau de bord d'une mission dont le modèle a une version (jeu de démonstration incomplet) :
 * étapes, complétude par concept avec ce qui manque, à faire. `E2E_SCREENSHOT=1` écrit aussi la
 * capture remise au PO (`docs/wp/WP-07-dashboard.png`).
 */
test('tableau de bord de la mission pilote avec un modèle partiel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 980 });
  await loginAndEnroll(page, ACCOUNTS.manager);

  const me = await (await page.request.get('/api/me')).json();
  const missions = (await (await page.request.get('/api/missions')).json()) as {
    id: string;
    name: string;
  }[];
  const pilot = missions.find((mission) => mission.name === 'Cabinet pilote');
  expect(pilot).toBeDefined();
  const committed = await page.request.post(`/api/missions/${pilot?.id}/model/changes`, {
    headers: { 'x-csrf-token': me.csrfToken as string },
    data: { changeSet },
  });
  expect(committed.status(), await committed.text()).toBe(201);

  await page.goto(`/missions/${pilot?.id}`);
  await expect(page.locator('.mission-name').filter({ hasText: 'Cabinet pilote' })).toBeVisible();
  await expect(page.getByText('IA simulée', { exact: true })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'EN COURS' })).toContainText(
    'Analyse du métier',
  );

  const actors = page.getByRole('button', { name: /^Acteurs/ });
  await expect(actors).toBeVisible();
  await actors.click();
  await expect(actors).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(/Manque :/)).toBeVisible();
  await expect(page.getByText('2 hypothèse(s) à examiner')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Indicateurs/ })).toContainText('0 %');
  await expectNoSeriousViolations(page);

  if (process.env['E2E_SCREENSHOT']) {
    await page.screenshot({ path: SCREENSHOT, fullPage: true });
  }
});
