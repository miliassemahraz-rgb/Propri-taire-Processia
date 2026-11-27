/**
 * @processia/exports : moteur d'exports du dossier d'analyse (WP-15) ; le rapport de mission et
 * le BPMN s'y ajouteront (WP-24). Un document neutre (`DossierDocument`, issu de
 * `deliverableView` et du catalogue i18n) est restitué par un adaptateur par format.
 */
import { createHash } from 'node:crypto';
import type { ExportFormat } from '@processia/contracts';

export const PACKAGE_NAME = '@processia/exports' as const;

export { buildDossier, documentTables } from './dossier/build.js';
export type { DossierInput, DossierSource } from './dossier/build.js';
export { renderDocx } from './docx/render.js';
export { renderXlsx, sheetName } from './xlsx/render.js';
export { renderDossierHtml } from './pdf/template.js';
export { renderPdf } from './pdf/render.js';
export type { PdfOptions } from './pdf/render.js';

/** Type MIME et extension de chaque format d'export. */
export const EXPORT_FORMAT_META: Record<ExportFormat, { mime: string; extension: string }> = {
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  },
  pdf: { mime: 'application/pdf', extension: 'pdf' },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  },
};

/** Empreinte sha256 (hexadécimal) d'un fichier produit. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
