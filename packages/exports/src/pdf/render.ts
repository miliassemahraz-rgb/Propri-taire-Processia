import type { DossierDocument } from '@processia/contracts';
import { t } from '@processia/i18n';
import { chromium } from 'playwright-core';
import { renderDossierHtml } from './template.js';

export interface PdfOptions {
  /**
   * Chromium à lancer (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`). Absent : celui que Playwright a
   * installé (`PLAYWRIGHT_BROWSERS_PATH`), comme dans l'image du worker.
   */
  executablePath?: string | undefined;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Dossier d'analyse en PDF : le gabarit HTML est imprimé par Chromium (`page.pdf`), avec les
 * signets issus des titres (`outline`) et un PDF balisé (`tagged`). Le PDF n'est pas certifié
 * PDF/UA (audit RGAA complet à l'incrément 5, risque R-8). Les octets varient d'un rendu à
 * l'autre (date de création, identifiant) ; le texte, lui, est identique.
 */
export async function renderPdf(
  doc: DossierDocument,
  options: PdfOptions = {},
): Promise<Uint8Array> {
  const html = renderDossierHtml(doc);
  const browser = await chromium.launch({
    ...(options.executablePath === undefined || options.executablePath === ''
      ? {}
      : { executablePath: options.executablePath }),
  });
  try {
    // Aucun script ne doit s'exécuter dans le gabarit : le contenu vient du modèle.
    const context = await browser.newContext({ javaScriptEnabled: false, locale: 'fr-FR' });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const footer = `${escapeHtml(doc.title)} · ${escapeHtml(t('exports.document.page'))}`;
    const pdf = await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
      tagged: true,
      outline: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:8px;text-align:center;font-family:sans-serif">${footer}<span class="pageNumber"></span>${escapeHtml(t('exports.document.pageOf'))}<span class="totalPages"></span></div>`,
      margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
    });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}
