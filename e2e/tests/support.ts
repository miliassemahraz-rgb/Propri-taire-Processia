import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { generateSync } from 'otplib';
import { testDbEnv } from '../test-env.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Mot de passe de développement des comptes du seed (`docs/dev/RUNBOOK.md`). */
export const DEV_PASSWORD = 'Processia-dev-2026!';

export const ACCOUNTS = {
  admin: 'admin@processia.local',
  manager: 'responsable@processia.local',
  consultantA: 'consultante1@processia.local',
  consultantB: 'consultant2@processia.local',
  validator: 'validateur@processia.local',
} as const;

const TOTP_STEP_MS = 30_000;
/** Fenêtre du limiteur de débit de l'API (60 s) : une pause de 25 s suffit souvent à repasser. */
const RATE_LIMIT_PAUSE_MS = 25_000;

/**
 * Code TOTP courant d'un compte déjà enrôlé, par l'outil de développement
 * `pnpm --filter @processia/api dev:totp <courriel>` (jamais disponible en production).
 */
export function devTotp(email: string): string {
  const output = execFileSync(
    'node',
    [
      '--env-file=.env.example',
      '--env-file-if-exists=.env',
      'apps/api/dist/cli/dev-totp.js',
      email,
    ],
    { cwd: root, env: { ...process.env, ...testDbEnv, NODE_ENV: 'development' }, encoding: 'utf8' },
  );
  return output.trim();
}

/** Code TOTP calculé depuis la clé de saisie manuelle affichée à l'enrôlement. */
export function totpFromKey(manualEntryKey: string, offsetSteps = 0): string {
  return generateSync({
    secret: manualEntryKey.replace(/\s+/g, ''),
    epoch: Math.floor(Date.now() / 1000) + offsetSteps * 30,
  });
}

/** Le serveur refuse un code déjà consommé (anti-rejeu) : attend le pas suivant si besoin. */
const lastCodeByEmail = new Map<string, string>();
export async function freshDevTotp(email: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = devTotp(email);
    if (lastCodeByEmail.get(email) !== code) {
      lastCodeByEmail.set(email, code);
      return code;
    }
    const wait = TOTP_STEP_MS - (Date.now() % TOTP_STEP_MS) + 500;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw new Error('Impossible d’obtenir un code TOTP neuf.');
}

/** Aucune violation axe-core `serious` ou `critical` (WCAG 2.0/2.1 A et AA). */
export async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

/** Saisit courriel et mot de passe sur la page de connexion et valide. */
export async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/connexion');
  await page.getByLabel('Adresse de courriel').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

/**
 * Premier passage d'un compte : connexion, enrôlement du TOTP (clé lue sur la page), codes de
 * secours conservés. Laisse la session ouverte sur la page « Missions ».
 */
export async function loginAndEnroll(
  page: Page,
  email: string,
  password: string = DEV_PASSWORD,
): Promise<{ recoveryCodes: string[] }> {
  await submitLogin(page, email, password);
  await expect(page).toHaveURL(/\/connexion\/enrolement/);
  const key = (await page.getByTestId('manual-key').textContent()) ?? '';
  expect(key).not.toBe('');
  const code = totpFromKey(key);
  lastCodeByEmail.set(email, code);
  await page.getByLabel('Code à 6 chiffres').fill(code);
  await page.getByRole('button', { name: 'Activer' }).click();
  await expect(page.getByRole('heading', { name: 'Conservez vos codes de secours' })).toBeVisible();
  const recoveryCodes = await page
    .getByRole('list', { name: 'Codes de secours' })
    .locator('code')
    .allTextContents();
  await page.getByRole('button', { name: 'J’ai conservé mes codes, continuer' }).click();
  await expect(page).toHaveURL(/\/missions$/);
  return { recoveryCodes };
}

/**
 * Connexion d'un compte quel que soit son état : enrôlement du TOTP s'il n'en a pas encore, code
 * de l'outil `dev:totp` sinon (les parcours E2E partagent la base, l'ordre des fichiers varie).
 */
export async function loginAnyState(
  page: Page,
  email: string,
  password: string = DEV_PASSWORD,
): Promise<void> {
  // Le limiteur de débit de l'API (30 appels par minute et par adresse sur `/auth/*`) peut
  // refuser la connexion après de nombreux parcours : on attend la fin de la fenêtre et on réessaie.
  for (let attempt = 0; ; attempt += 1) {
    await submitLogin(page, email, password);
    try {
      await page.waitForURL(/\/connexion\/(enrolement|verification)/, { timeout: 8_000 });
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      await page.waitForTimeout(RATE_LIMIT_PAUSE_MS);
    }
  }
  if (page.url().includes('/connexion/enrolement')) {
    // Le limiteur de débit de l'API (30 appels par minute et par adresse) peut refuser l'appel
    // d'enrôlement après de nombreuses connexions : on attend la fin de la fenêtre et on recharge.
    const manualKey = page.getByTestId('manual-key');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await manualKey.waitFor({ timeout: 8_000 });
        break;
      } catch {
        await page.waitForTimeout(25_000);
        await page.reload();
      }
    }
    const key = (await manualKey.textContent()) ?? '';
    const code = totpFromKey(key);
    lastCodeByEmail.set(email, code);
    await page.getByLabel('Code à 6 chiffres').fill(code);
    await page.getByRole('button', { name: 'Activer' }).click();
    await page.getByRole('button', { name: 'J’ai conservé mes codes, continuer' }).click();
  } else {
    for (let attempt = 0; ; attempt += 1) {
      await page.getByLabel('Code à 6 chiffres').fill(await freshDevTotp(email));
      await page.getByRole('button', { name: 'Vérifier' }).click();
      try {
        await page.waitForURL(/\/missions$/, { timeout: 8_000 });
        break;
      } catch (error) {
        // Refus du limiteur de débit : on attend la fin de la fenêtre puis un code neuf.
        if (attempt >= 3) throw error;
        await page.waitForTimeout(RATE_LIMIT_PAUSE_MS);
      }
    }
  }
  await expect(page).toHaveURL(/\/missions$/);
}

/** Connexion d'un compte déjà enrôlé, avec le code de l'outil `dev:totp`. */
export async function loginWithDevTotp(
  page: Page,
  email: string,
  password: string = DEV_PASSWORD,
): Promise<void> {
  await submitLogin(page, email, password);
  await expect(page).toHaveURL(/\/connexion\/verification/);
  await page.getByLabel('Code à 6 chiffres').fill(await freshDevTotp(email));
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page).toHaveURL(/\/missions$/);
}

/** Lien d'invitation lu dans la boîte Mailpit de développement. */
export async function invitationLinkFor(email: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const list = (await (await fetch('http://localhost:8025/api/v1/messages')).json()) as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    const found = list.messages.find((message) => message.To.some((to) => to.Address === email));
    if (found !== undefined) {
      const detail = (await (
        await fetch(`http://localhost:8025/api/v1/message/${found.ID}`)
      ).json()) as {
        Text: string;
      };
      const match = /https?:\/\/\S+\/invitations\/[\w-]+/.exec(detail.Text);
      if (match !== null) return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Aucune invitation reçue pour ${email}.`);
}

/** Message d'erreur affiché par la page (exclut l'annonceur de routes de Next, aussi en `role=alert`). */
export function alertOf(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}
