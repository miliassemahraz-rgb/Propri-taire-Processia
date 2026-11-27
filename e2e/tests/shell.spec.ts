import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  ACCOUNTS,
  DEV_PASSWORD,
  alertOf,
  expectNoSeriousViolations,
  freshDevTotp,
  invitationLinkFor,
  loginAndEnroll,
  loginWithDevTotp,
  submitLogin,
} from './support.js';

/**
 * Parcours de WP-07 (coquille web) contre l'API réelle et la base de test. Les tests sont
 * enchaînés : chacun s'appuie sur l'état laissé par le précédent (comptes enrôlés, mission créée).
 */
test.describe.configure({ mode: 'serial' });

const NEW_MANAGER = 'nouveau.responsable@processia.local';
const NEW_PASSWORD = 'Un-mot-de-passe-solide-2026!';
const CLIENT_NAME = 'Client E2E';
const MISSION_NAME = 'Mission E2E';

const titles = new Map<string, string>();
async function recordTitle(page: Page, label: string): Promise<void> {
  titles.set(label, await page.title());
}

let adminContext: BrowserContext;
let managerContext: BrowserContext;
let missionUrl = '';

async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ locale: 'fr-FR' });
}

test.describe('coquille web', () => {
  test.beforeAll(async ({ browser }) => {
    adminContext = await newContext(browser);
    managerContext = await newContext(browser);
  });
  test.afterAll(async () => {
    await adminContext.close();
    await managerContext.close();
  });

  test('connexion : page accessible, en français, erreurs traduites', async ({ page }) => {
    await page.goto('/connexion');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Connexion à Processia' }),
    ).toBeVisible();
    await recordTitle(page, 'connexion');
    await expectNoSeriousViolations(page);

    await page.getByLabel('Adresse de courriel').fill(ACCOUNTS.admin);
    await page.getByLabel('Mot de passe').fill('mauvais-mot-de-passe');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(alertOf(page)).toHaveText('Adresse de courriel ou mot de passe incorrect.');
    await expectNoSeriousViolations(page);
  });

  test('une page authentifiée sans session renvoie à la connexion', async ({ page }) => {
    await page.goto('/missions');
    await expect(page).toHaveURL(/\/connexion\?next=%2Fmissions/);
  });

  test('administrateur : connexion, enrôlement du TOTP puis codes de secours', async () => {
    const page = await adminContext.newPage();
    await submitLogin(page, ACCOUNTS.admin, DEV_PASSWORD);
    await expect(page).toHaveURL(/\/connexion\/enrolement/);
    await expect(page.getByAltText(/Code QR/)).toBeVisible();
    await recordTitle(page, 'enrolement');
    await expectNoSeriousViolations(page);
    await page.close();

    const fresh = await adminContext.newPage();
    const { recoveryCodes } = await loginAndEnroll(fresh, ACCOUNTS.admin);
    expect(recoveryCodes).toHaveLength(10);
    await expect(fresh.getByRole('heading', { level: 1, name: 'Missions' })).toBeVisible();
    await fresh.close();
  });

  test('administrateur : pages d’administration accessibles', async () => {
    const page = await adminContext.newPage();
    await page.goto('/administration/utilisateurs');
    await expect(page.getByRole('heading', { level: 1, name: 'Utilisateurs' })).toBeVisible();
    await expect(page.getByRole('cell', { name: ACCOUNTS.validator })).toBeVisible();
    await recordTitle(page, 'admin-utilisateurs');
    await expectNoSeriousViolations(page);

    await page.goto('/administration/clients');
    await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible();
    await page.getByLabel('Nom du client').fill(CLIENT_NAME);
    await page.getByRole('button', { name: 'Créer le client' }).click();
    await expect(page.getByRole('cell', { name: CLIENT_NAME })).toBeVisible();
    await recordTitle(page, 'admin-clients');
    await expectNoSeriousViolations(page);

    await page.goto('/administration/ia');
    await expect(page.getByRole('heading', { level: 1, name: 'Fournisseur IA' })).toBeVisible();
    await expect(page.getByText('Aucune configuration enregistrée')).toBeVisible();
    await recordTitle(page, 'admin-ia');
    await expectNoSeriousViolations(page);
    await page.getByRole('tab', { name: 'Politique de données' }).click();
    await expectNoSeriousViolations(page);
    await page.close();
  });

  test('administrateur : configuration du fournisseur IA avec avertissement de capacité', async () => {
    const page = await adminContext.newPage();
    await page.goto('/administration/ia');
    await expect(page.getByText('Aucune configuration enregistrée')).toBeVisible();
    await page.getByText('Documents (PDF, images)').click();
    await expect(page.getByLabel('Documents (PDF, images)')).not.toBeChecked();
    await page.getByRole('button', { name: 'Enregistrer la configuration' }).click();
    await expect(page.getByText('Configuration enregistrée.')).toBeVisible();
    await expect(page.getByText(/ne déclare pas la capacité « documents »/)).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.close();
  });

  test('invitation : l’administrateur invite, la personne crée son compte', async ({ browser }) => {
    const admin = await adminContext.newPage();
    await admin.goto('/administration/utilisateurs');
    await admin.getByLabel('Adresse de courriel').fill(NEW_MANAGER);
    await admin.getByRole('button', { name: 'Rôle global' }).click();
    await admin.getByRole('option', { name: 'Responsable de mission' }).click();
    await admin.getByRole('button', { name: 'Envoyer l’invitation' }).click();
    await expect(admin.getByText(`Invitation envoyée à ${NEW_MANAGER}.`)).toBeVisible();
    await admin.close();

    const link = await invitationLinkFor(NEW_MANAGER);
    const guest = await (await newContext(browser)).newPage();
    await guest.goto(link);
    await expect(
      guest.getByRole('heading', { level: 1, name: 'Bienvenue sur Processia' }),
    ).toBeVisible();
    await recordTitle(guest, 'invitation');
    await expectNoSeriousViolations(guest);

    // Mot de passe courant : refusé (erreur traduite), l'invitation n'est pas consommée.
    await guest.getByLabel('Nom affiché').fill('Nina Nouvelle');
    await guest.getByLabel('Mot de passe').fill('password1234');
    await guest.getByRole('button', { name: 'Créer mon compte' }).click();
    await expect(alertOf(guest)).toContainText('trop faible ou trop courant');
    await guest.getByLabel('Mot de passe').fill(NEW_PASSWORD);
    await guest.getByRole('button', { name: 'Créer mon compte' }).click();
    await expect(guest.getByRole('heading', { name: 'Compte créé' })).toBeVisible();
    await expectNoSeriousViolations(guest);

    // Le lien est à usage unique : une seconde utilisation affiche l'erreur traduite.
    await guest.goto(link);
    await guest.getByLabel('Nom affiché').fill('Nina Nouvelle');
    await guest.getByLabel('Mot de passe').fill(NEW_PASSWORD);
    await guest.getByRole('button', { name: 'Créer mon compte' }).click();
    await expect(alertOf(guest)).toContainText('invitation est invalide, expirée ou déjà utilisée');
    await guest.context().close();
  });

  test('nouveau responsable : enrôlement TOTP, création de mission, affectations', async () => {
    const page = await managerContext.newPage();
    await loginAndEnroll(page, NEW_MANAGER, NEW_PASSWORD);
    await recordTitle(page, 'missions');
    await expectNoSeriousViolations(page);

    await page.getByRole('button', { name: 'Nouvelle mission' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle mission' });
    await expect(dialog).toBeVisible();
    await expectNoSeriousViolations(page);
    await dialog.getByRole('button', { name: /Client/ }).click();
    await page.getByRole('option', { name: CLIENT_NAME }).click();
    await dialog.getByLabel('Nom de la mission').fill(MISSION_NAME);
    await dialog.getByRole('button', { name: 'Créer la mission' }).click();

    await expect(page).toHaveURL(/\/missions\/[0-9a-f-]{36}$/);
    missionUrl = page.url();
    await expect(page.locator('.mission-name').filter({ hasText: MISSION_NAME })).toBeVisible();
    await expect(page.getByText('IA simulée', { exact: true })).toBeVisible();
    await recordTitle(page, 'mission-tableau-de-bord');
    await expectNoSeriousViolations(page);

    await page.getByRole('link', { name: 'Équipe' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Équipe de la mission' }),
    ).toBeVisible();
    await recordTitle(page, 'mission-equipe');
    await expectNoSeriousViolations(page);

    // Espace Analyse (WP-13) : titre unique ; le parcours détaillé est dans `z-analyse.spec.ts`.
    await page.getByRole('link', { name: 'Analyse' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Analyse du métier' })).toBeVisible();
    await expect(page.getByText('Coédition active')).toBeVisible({ timeout: 15_000 });
    await recordTitle(page, 'mission-analyse');
    await expectNoSeriousViolations(page);
    await page.getByRole('link', { name: 'Équipe' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Équipe de la mission' }),
    ).toBeVisible();

    const assign = async (name: string, role: string) => {
      await page.getByRole('button', { name: /Utilisateur/ }).click();
      await page.getByRole('option', { name: new RegExp(name) }).click();
      await page
        .getByRole('button', { name: /Rôle dans la mission/ })
        .first()
        .click();
      await page.getByRole('option', { name: role, exact: true }).click();
      await page.getByRole('button', { name: 'Affecter', exact: true }).click();
      await expect(page.getByRole('cell', { name: new RegExp(name) }).first()).toBeVisible();
    };
    await assign(ACCOUNTS.consultantA, 'Consultant');
    await assign(ACCOUNTS.consultantB, 'Consultant');
    await assign(ACCOUNTS.validator, 'Validateur');

    const table = page.getByRole('table', { name: 'Membres de la mission' });
    await expect(table.getByRole('row')).toHaveCount(5); // en-tête, le responsable créateur et trois membres
    await expect(table.getByRole('cell', { name: 'Validateur', exact: true })).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.getByRole('link', { name: 'Missions' }).first().click();
    await expect(page.getByRole('link', { name: MISSION_NAME })).toBeVisible();
    await page.close();
  });

  test('connexion d’un compte enrôlé avec le code de l’outil dev:totp', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await submitLogin(page, ACCOUNTS.admin, DEV_PASSWORD);
    await expect(page).toHaveURL(/\/connexion\/verification/);
    await recordTitle(page, 'verification');
    await expectNoSeriousViolations(page);

    // Un code faux est refusé avec un message en français.
    await page.getByLabel('Code à 6 chiffres').fill('000000');
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await expect(alertOf(page)).toContainText('Code invalide ou expiré');

    await page.getByLabel('Code à 6 chiffres').fill(await freshDevTotp(ACCOUNTS.admin));
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await expect(page).toHaveURL(/\/missions$/);
    await expect(page.getByText('Connecté : Alice Administratrice')).toBeVisible();

    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/connexion/);
    await context.close();
  });

  test('un consultant non administrateur n’a pas le menu d’administration', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    // Premier passage du consultant : enrôlement, puis lecture seule des missions affectées.
    await loginAndEnroll(page, ACCOUNTS.consultantA);
    await expect(
      page.getByRole('navigation', { name: 'Navigation de l’administration' }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nouvelle mission' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: MISSION_NAME })).toBeVisible();
    await page.getByRole('link', { name: MISSION_NAME }).click();
    await expect(page.locator('.mission-name').filter({ hasText: MISSION_NAME })).toBeVisible();
    await expectNoSeriousViolations(page);
    await context.close();
  });

  test('le validateur voit sa mission sans avancement ni accès à l’équipe', async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await loginAndEnroll(page, ACCOUNTS.validator);
    await page.getByRole('link', { name: MISSION_NAME }).click();
    await expect(page.locator('.mission-name').filter({ hasText: MISSION_NAME })).toBeVisible();
    await expect(page.getByText('Le modèle n’est pas accessible avec votre rôle.')).toBeVisible();
    await page.goto(`${missionUrl}/equipe`);
    await expect(alertOf(page)).toContainText('pas le droit');
    await context.close();
  });

  test('page introuvable accessible', async ({ page }) => {
    await page.goto('/une-page-qui-nexiste-pas');
    await expect(page.getByRole('heading', { level: 1, name: 'Page introuvable' })).toBeVisible();
    await recordTitle(page, 'introuvable');
    await expectNoSeriousViolations(page);
  });

  test('navigation au clavier : lien d’évitement, ordre de tabulation, dialogue', async ({
    browser,
  }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await loginWithDevTotp(page, ACCOUNTS.admin);

    // Le premier élément focalisable est le lien d'évitement.
    await page.goto('/missions');
    await expect(page.getByRole('heading', { level: 1, name: 'Missions' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Aller au contenu principal' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#contenu')).toBeFocused();

    // Parcours complet avec Tab : chaque contrôle de la page est atteint, dans l'ordre visuel.
    await page.goto('/missions');
    await expect(page.getByRole('heading', { level: 1, name: 'Missions' })).toBeVisible();
    const seen: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      await page.keyboard.press('Tab');
      const label = await page.evaluate(() => {
        const element = document.activeElement;
        if (element === null || element === document.body) return '';
        const aria = element.getAttribute('aria-label');
        if (aria !== null) return aria;
        const labelled = (element as HTMLInputElement).labels?.[0]?.textContent;
        return (labelled ?? element.textContent ?? '').trim();
      });
      seen.push(label);
      if (label === 'Aller au contenu principal' && index > 0) break;
    }
    const expectedInOrder = [
      'Aller au contenu principal',
      'Missions',
      'Utilisateurs',
      'Clients',
      'Fournisseur IA',
      'Simple',
      'Se déconnecter',
      'Notifications',
      'Nouvelle mission',
    ];
    let cursor = 0;
    for (const label of seen) {
      if (label.startsWith(expectedInOrder[cursor] ?? '\u0000')) cursor += 1;
    }
    expect(cursor, `ordre de tabulation observé : ${JSON.stringify(seen)}`).toBe(
      expectedInOrder.length,
    );

    // Dialogue : ouverture au clavier, focus piégé, Échap referme et rend le focus.
    const open = page.getByRole('button', { name: 'Nouvelle mission' });
    await open.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Nouvelle mission' });
    await expect(dialog).toBeVisible();
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();

    // Centre de notifications : vide, accessible au clavier.
    await page.getByRole('button', { name: 'Notifications' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Aucune notification pour le moment.')).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.keyboard.press('Escape');

    // Mode expert : mémorisé, change le contenu du tableau de bord.
    await page.getByText('Expert', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Expert' })).toBeChecked();
    await page.getByRole('link', { name: MISSION_NAME }).click();
    await expect(page.getByText(/Version de tête du modèle/)).toBeVisible();
    await expectNoSeriousViolations(page);
    await context.close();
  });

  test('chaque page a un titre unique', () => {
    const values = [...titles.values()];
    expect(values.length).toBeGreaterThanOrEqual(12);
    for (const value of values) expect(value).toMatch(/ · Processia$/);
    expect(new Set(values).size, JSON.stringify([...titles.entries()])).toBe(values.length);
  });
});
