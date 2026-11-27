import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { PILOT_DESCRIPTION } from '@processia/test-fixtures';
import { ACCOUNTS, expectNoSeriousViolations, loginAnyState } from './support.js';

const SCREENSHOT = fileURLToPath(new URL('../../docs/wp/WP-16-portail.png', import.meta.url));
const EDITOR_NAME = 'Description du métier du client';
const MISSION_NAME = 'Validation E2E du pilote';
/** Hypothèses laissées sans décision : exclues de la soumission, jamais vues du validateur. */
const UNDECIDED = [
  'Saisonnalité de l’activité',
  'Logiciel de GED',
  'Commissaire aux comptes',
  'Contrôle de la balance',
];
const MAILPIT = 'http://localhost:8025/api/v1';

/**
 * Circuit de validation (WP-16) : un consultant soumet le dossier d'analyse (hypothèses exclues
 * listées, exports joints), le validateur (seul compte client) lit la version figée, commente,
 * le consultant répond, une nouvelle soumission remplace la première, le validateur valide : les
 * éléments passent à `validated`, la phase à `mapping`, la cartographie s'ouvre. Une modification
 * ultérieure d'un élément validé crée un signalement et un courriel (Mailpit). Mission dédiée.
 * `E2E_SCREENSHOT=1` écrit la capture du portail remise au PO.
 */
test.describe.configure({ mode: 'serial' });

let missionId = '';
const STARTED = Date.now();

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

/** Courriels reçus par une adresse depuis le début du fichier (Mailpit). */
async function mails(address: string): Promise<{ Subject: string; ID: string }[]> {
  const list = (await (await fetch(`${MAILPIT}/messages?limit=200`)).json()) as {
    messages: { ID: string; Subject: string; Created: string; To: { Address: string }[] }[];
  };
  return list.messages.filter(
    (m) => Date.parse(m.Created) >= STARTED - 2000 && m.To.some((to) => to.Address === address),
  );
}

async function waitMail(address: string, subject: RegExp): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const found = (await mails(address)).find((m) => subject.test(m.Subject));
    if (found !== undefined) {
      const detail = (await (await fetch(`${MAILPIT}/message/${found.ID}`)).json()) as {
        Text: string;
      };
      return detail.Text;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Aucun courriel pour ${address} (${String(subject)}).`);
}

test.describe('circuit de validation du dossier d’analyse', () => {
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

  test('analyse du pilote, puis « Soumettre au validateur » : hypothèses exclues listées', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.consultantA);
    await page.goto(`/missions/${missionId}/analyse`);
    await expect(page.getByText('Coédition active')).toBeVisible({ timeout: 15_000 });
    await paste(page, PILOT_DESCRIPTION);
    await page.getByRole('button', { name: 'Analyser', exact: true }).click();
    await expect(page.getByText('Analyse terminée')).toBeVisible({ timeout: 60_000 });
    const section = page.getByTestId('hypotheses-section');
    await section.getByRole('button', { name: 'Proposer des hypothèses' }).click();
    await expect(page.getByText('Propositions prêtes')).toBeVisible({ timeout: 30_000 });
    await page
      .getByTestId('hypothesis-card')
      .filter({ hasText: 'Liasse fiscale' })
      .getByRole('button', { name: /^Accepter/ })
      .click();
    await expect(section.getByTestId('hypotheses-count')).toHaveText('(4)');

    // Critère 2 : avant la validation, la cartographie est verrouillée.
    const locked = await page.request.get(`/api/missions/${missionId}/mapping`);
    expect(locked.status()).toBe(409);
    expect(((await locked.json()) as { code: string }).code).toBe('PHASE_LOCKED');

    await page.getByRole('button', { name: 'Soumettre au validateur' }).click();
    const dialog = page.getByTestId('submit-dialog');
    await expect(dialog.getByTestId('submit-excluded-title')).toContainText(
      `Hypothèses exclues : ${UNDECIDED.length}`,
    );
    for (const label of UNDECIDED) await expect(dialog).toContainText(label);
    await expect(dialog.getByTestId('submit-included')).toContainText('éléments seront soumis');
    await expectNoSeriousViolations(page);
    await dialog.getByRole('button', { name: /^Soumettre la version/ }).click();

    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/validation$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Validation' })).toBeVisible();
    await expect(page.getByTestId('step-analysis_dossier')).toContainText(
      '1. Dossier d’analyse : en cours de validation',
    );
    await expect(page.getByTestId('step-as_is')).toContainText('2. AS-IS : à venir');
    await expect(page.getByTestId('submission-title')).toHaveText('Soumission n°1');
    // Le consultant voit les hypothèses exclues.
    const excluded = page.getByTestId('excluded-list');
    for (const label of UNDECIDED) await expect(excluded).toContainText(label);
    // Les exports joints arrivent au fil de l'eau (Word, PDF, Excel).
    await page.getByRole('tab', { name: 'Fichiers' }).click();
    await expect(page.getByTestId('submission-export')).toHaveCount(3, { timeout: 60_000 });
    await expectNoSeriousViolations(page);
    await context.close();
  });

  test('portail du validateur : version figée sans hypothèse, commentaire, exports téléchargés', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.validator);

    // Courriel de soumission (Mailpit) et notification dans l'application.
    const body = await waitMail(ACCOUNTS.validator, /Dossier d’analyse à valider/);
    expect(body).toContain(`/missions/${missionId}/validation`);
    await page.goto(`/missions/${missionId}`);
    // La navigation du validateur se limite au tableau de bord et à la validation.
    const nav = page.getByRole('navigation', { name: /mission/i });
    await expect(nav.getByRole('link')).toHaveText(['Tableau de bord', 'Validation']);
    await nav.getByRole('link', { name: 'Validation' }).click();
    await expect(page).toHaveURL(new RegExp(`/missions/${missionId}/validation$`));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Validez le dossier d’analyse' }),
    ).toBeVisible();
    await expect(page.getByText('Processia · Portail du validateur')).toBeVisible();
    await expect(page.getByTestId('step-analysis_dossier')).toHaveAttribute(
      'data-state',
      'pending',
    );
    await expect(page.getByTestId('frozen-notice')).toContainText('figée');
    // Seul le consultant voit la liste des hypothèses exclues.
    await expect(page.getByTestId('excluded-list')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Hypothèses exclues/ })).toHaveCount(0);
    // Pas de bouton « Refuser » : on commente.
    await expect(page.getByRole('button', { name: /Refuser/ })).toHaveCount(0);

    // La version lue : les quatre livrables, jamais une hypothèse.
    await expect(page.getByTestId('deliverable-business_sheet')).toContainText('Liasse fiscale');
    const text = await page.locator('main').innerText();
    for (const label of UNDECIDED) expect(text).not.toContain(label);

    // Critère 4 : aucune route d'édition, aucune lecture de la tête du modèle.
    const headers = await csrf(page);
    expect((await page.request.get(`/api/missions/${missionId}/model`)).status()).toBe(403);
    expect(
      (
        await page.request.post(`/api/missions/${missionId}/model/changes`, {
          headers,
          data: { changeSet: { baseVersion: 1, ops: [], cause: 'extraction', summary: 'x' } },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post(`/api/missions/${missionId}/elements/x/decision`, {
          headers,
          data: { decision: 'accept' },
        })
      ).status(),
    ).toBe(403);

    // Commentaire sur un élément de la version figée.
    await page.getByRole('tab', { name: 'Éléments' }).click();
    const rows = page.getByTestId('element-row');
    await expect(rows.first()).toBeVisible();
    const hypothesisRow = rows.filter({ hasText: 'Logiciel de GED' });
    await expect(hypothesisRow).toHaveCount(0);
    await rows
      .first()
      .getByRole('button', { name: /^Commentaires sur/ })
      .click();
    const thread = page.getByTestId('comment-thread');
    await thread
      .getByRole('textbox', { name: 'Votre commentaire' })
      .fill('Cet élément est-il complet ?');
    await thread.getByRole('button', { name: 'Envoyer' }).click();
    await expect(page.getByTestId('comment')).toContainText('Cet élément est-il complet ?');

    // Commentaire général dans la discussion de la soumission.
    await page.getByRole('tab', { name: 'Discussion' }).click();
    await page
      .getByRole('textbox', { name: 'Votre commentaire' })
      .fill('Merci de confirmer les délais de relance.');
    await page.getByRole('button', { name: 'Envoyer' }).click();
    await expect(page.getByTestId('comment')).toContainText('délais de relance');

    // Fichiers joints : téléchargement et empreinte.
    await page.getByRole('tab', { name: 'Fichiers' }).click();
    const files = page.getByTestId('submission-export');
    await expect(files).toHaveCount(3, { timeout: 30_000 });
    const word = files.filter({ has: page.getByRole('rowheader', { name: 'Word' }) });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      word.getByRole('button', { name: /^Télécharger le fichier/ }).click(),
    ]);
    const bytes = readFileSync((await download.path()) as string);
    expect(download.suggestedFilename()).toMatch(
      /^dossier-analyse-validation-e2e-du-pilote-v\d+\.docx$/,
    );
    const sha = createHash('sha256').update(bytes).digest('hex');
    await expect(word.locator('.mono')).toHaveText(`${sha.slice(0, 12)}…`);

    await page.getByRole('tab', { name: 'Dossier' }).click();
    await expectNoSeriousViolations(page);
    if (process.env['E2E_SCREENSHOT']) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: SCREENSHOT, fullPage: false });
    }
    await context.close();
  });

  test('le consultant répond en direct ; le travail qui continue ne change pas la version figée ; nouvelle soumission', async ({
    browser,
  }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const contextV = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const pageA = await contextA.newPage();
    const pageV = await contextV.newPage();
    await loginAnyState(pageA, ACCOUNTS.consultantA);
    await loginAnyState(pageV, ACCOUNTS.validator);
    await pageA.goto(`/missions/${missionId}/validation`);
    await pageV.goto(`/missions/${missionId}/validation`);

    // Le consultant voit les commentaires du validateur sans recharger, et répond.
    await pageA.getByRole('tab', { name: 'Discussion' }).click();
    await expect(pageA.getByTestId('comment')).toContainText('délais de relance', {
      timeout: 15_000,
    });
    await pageA
      .getByRole('textbox', { name: 'Votre commentaire' })
      .fill('Délais confirmés : 5 jours ouvrés.');
    await pageA.getByRole('button', { name: 'Envoyer' }).click();
    await pageV.getByRole('tab', { name: 'Discussion' }).click();
    await expect(
      pageV.getByTestId('comment-reply').or(pageV.getByTestId('comment')).last(),
    ).toContainText('5 jours ouvrés', { timeout: 15_000 });

    // Le consultant accepte une hypothèse de plus : la tête avance, la version figée non.
    const headers = await csrf(pageA);
    const head = (await (await pageA.request.get(`/api/missions/${missionId}/model`)).json()) as {
      version: number;
      model: { elements: Record<string, { id: string; label: string }> };
    };
    const ged = Object.values(head.model.elements).find((e) => e.label === 'Logiciel de GED');
    const decided = await pageA.request.post(
      `/api/missions/${missionId}/elements/${ged?.id}/decision`,
      { headers, data: { decision: 'accept' } },
    );
    expect(decided.status(), await decided.text()).toBe(201);
    await pageV.reload();
    await expect(pageV.getByTestId('deliverable-business_sheet')).toBeVisible();
    expect(await pageV.locator('main').innerText()).not.toContain('Logiciel de GED');

    // Nouvelle soumission (maintenant avec l'élément confirmé) : la première est « Remplacée ».
    await pageA.goto(`/missions/${missionId}/analyse`);
    await expect(pageA.getByText('Coédition active')).toBeVisible({ timeout: 15_000 });
    await pageA.getByRole('button', { name: 'Soumettre au validateur' }).click();
    const dialog = pageA.getByTestId('submit-dialog');
    await expect(dialog).toContainText('remplace la soumission n°1');
    await expect(dialog.getByTestId('submit-excluded-title')).toContainText(
      `Hypothèses exclues : ${UNDECIDED.length - 1}`,
    );
    await dialog.getByRole('button', { name: /^Soumettre la version/ }).click();
    await expect(pageA).toHaveURL(new RegExp(`/validation$`));
    await expect(pageA.getByTestId('submission-title')).toHaveText('Soumission n°2');

    // Le validateur est prévenu et lit la soumission n°2 (aucune hypothèse non décidée).
    await expect(pageV.getByTestId('submission-title')).toHaveText('Soumission n°2', {
      timeout: 15_000,
    });
    await expect(pageV.getByTestId('dossier-panel')).toHaveAttribute('data-status', 'submitted');
    await pageV.getByRole('tab', { name: 'Éléments' }).click();
    await expect(
      pageV.getByTestId('element-row').filter({ hasText: 'Logiciel de GED' }),
    ).toHaveCount(1);
    await pageV.getByRole('tab', { name: 'Dossier' }).click();
    const text = await pageV.locator('main').innerText();
    for (const label of UNDECIDED.filter((l) => l !== 'Logiciel de GED')) {
      expect(text).not.toContain(label);
    }
    // Critère 5 : la première soumission est remplacée (et reste lisible).
    const states = (await (
      await pageA.request.get(`/api/missions/${missionId}/submissions`)
    ).json()) as {
      round: number;
      status: string;
    }[];
    expect(Object.fromEntries(states.map((s) => [s.round, s.status]))).toEqual({
      1: 'superseded',
      2: 'submitted',
    });
    await contextA.close();
    await contextV.close();
  });

  test('critère 1 : le validateur valide ; éléments validés, phase mapping, cartographie ouverte', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await loginAnyState(page, ACCOUNTS.validator);
    await page.goto(`/missions/${missionId}/validation`);
    await expect(page.getByTestId('submission-title')).toHaveText('Soumission n°2');
    await page.getByRole('button', { name: 'Valider le dossier' }).click();
    const dialog = page.getByTestId('validate-dialog');
    await expect(dialog).toContainText('ne peut pas être annulée');
    await dialog
      .getByRole('textbox', { name: 'Commentaire de validation (facultatif)' })
      .fill('Dossier conforme à nos pratiques.');
    await expectNoSeriousViolations(page);
    await dialog.getByRole('button', { name: 'Confirmer la validation' }).click();

    await expect(page.getByTestId('validated-banner')).toContainText('Dossier validé le', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('validated-banner')).toContainText('Dossier conforme');
    await expect(page.getByTestId('step-analysis_dossier')).toContainText(
      '1. Dossier d’analyse : validé',
    );
    await expect(page.getByTestId('step-as_is')).toContainText('2. AS-IS : à soumettre');
    await expect(page.getByRole('button', { name: 'Valider le dossier' })).toHaveCount(0);
    await expect(page.getByTestId('notices-panel')).toContainText(
      'Aucune modification depuis la validation.',
    );

    const mission = (await (await page.request.get(`/api/missions/${missionId}`)).json()) as {
      phase: string;
    };
    expect(mission.phase).toBe('mapping');
    await expectNoSeriousViolations(page);
    await context.close();

    // Côté consultant : éléments `validated`, phase `mapping`, cartographie ouverte.
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await loginAnyState(pageA, ACCOUNTS.consultantA);
    const head = (await (await pageA.request.get(`/api/missions/${missionId}/model`)).json()) as {
      model: { elements: Record<string, { label: string; status: { value: string } }> };
    };
    const elements = Object.values(head.model.elements);
    expect(elements.filter((e) => e.status.value === 'validated').length).toBeGreaterThan(5);
    expect(
      elements
        .filter((e) => UNDECIDED.includes(e.label) && e.label !== 'Logiciel de GED')
        .every((e) => e.status.value === 'hypothesis'),
    ).toBe(true);
    const gate = await pageA.request.get(`/api/missions/${missionId}/mapping`);
    expect(gate.status()).toBe(200);
    await pageA.goto(`/missions/${missionId}`);
    await expect(pageA.locator('.mission-header')).toContainText('Cartographie');
    await expect(pageA.getByTestId('notifications-button')).toBeVisible();
    await waitMail(ACCOUNTS.consultantA, /Dossier d’analyse validé/);
    await contextA.close();
  });

  test('critère 3 : modifier un élément validé crée un signalement visible du validateur et un courriel', async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextV = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const pageA = await contextA.newPage();
    const pageV = await contextV.newPage();
    await loginAnyState(pageA, ACCOUNTS.consultantA);
    await loginAnyState(pageV, ACCOUNTS.validator);
    await pageV.goto(`/missions/${missionId}/validation`);
    await expect(pageV.getByTestId('validated-banner')).toBeVisible();

    const headers = await csrf(pageA);
    const head = (await (await pageA.request.get(`/api/missions/${missionId}/model`)).json()) as {
      version: number;
      model: { elements: Record<string, { id: string; label: string; status: { value: string } }> };
    };
    const target = Object.values(head.model.elements).find(
      (e) => e.label === 'Liasse fiscale' && e.status.value === 'validated',
    );
    expect(target).toBeDefined();
    const changed = await pageA.request.post(`/api/missions/${missionId}/model/changes`, {
      headers,
      data: {
        changeSet: {
          baseVersion: head.version,
          ops: [{ op: 'update', id: target?.id, set: { label: 'Liasse fiscale corrigée' } }],
          cause: 'dialogue_edit',
          summary: 'Correction après validation',
        },
      },
    });
    expect(changed.status(), await changed.text()).toBe(201);
    const version = ((await changed.json()) as { version: number }).version;

    // Signalement visible du validateur (relève automatique), puis marqué comme vu.
    const panel = pageV.getByTestId('notices-panel');
    await expect(panel.getByTestId('notice')).toContainText('Liasse fiscale', { timeout: 20_000 });
    await expect(panel).toContainText(`Version ${version}`);
    await expect(panel.getByTestId('notices-unseen')).toContainText('1 signalement(s) non vu(s)');
    await expectNoSeriousViolations(pageV);

    // Courriel dans Mailpit, regroupé par version.
    const text = await waitMail(ACCOUNTS.validator, /modification après validation/);
    expect(text).toContain('Liasse fiscale');
    expect(text).toContain(`version ${version}`);

    // Notification dans l'application.
    await pageV.getByTestId('notifications-button').click();
    await expect(pageV.getByTestId('notifications-list')).toContainText(
      `Modification après validation (version ${version})`,
    );
    await pageV.keyboard.press('Escape');

    await panel.getByRole('button', { name: 'Marquer comme vus' }).click();
    await expect(panel.getByTestId('notice')).toContainText('Vu');
    await expect(panel.getByTestId('notices-unseen')).toHaveCount(0);
    await contextA.close();
    await contextV.close();
  });
});
