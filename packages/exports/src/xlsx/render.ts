import type { DocTable, DossierDocument } from '@processia/contracts';
import { t } from '@processia/i18n';
import ExcelJS from 'exceljs';
import { documentTables } from '../dossier/build.js';
import { normalizeZip } from '../zip.js';

const MAX_SHEET_NAME = 31;
const MIN_WIDTH = 8;
const MAX_WIDTH = 60;
const HEADER_FILL = 'FFE4E9F4';

/** Nom de feuille valide pour Excel : sans `[ ] : * ? / \`, 31 caractères au plus. */
export function sheetName(raw: string, taken: Set<string>): string {
  const base =
    raw
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, MAX_SHEET_NAME) || 'Feuille';
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
    const suffix = ` ${n}`;
    name = `${base.slice(0, MAX_SHEET_NAME - suffix.length)}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

function addTable(workbook: ExcelJS.Workbook, table: DocTable, name: string): void {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', xSplit: table.rowHeader ? 1 : 0, ySplit: 1 }],
    properties: { defaultRowHeight: 18 },
  });
  const header = sheet.addRow(table.columns);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  });
  for (const row of table.rows) {
    const added = sheet.addRow(row);
    added.alignment = { vertical: 'top', wrapText: true };
    if (table.rowHeader) added.getCell(1).font = { bold: true };
  }
  table.columns.forEach((column, index) => {
    const longest = Math.max(
      column.length,
      ...table.rows.map((row) =>
        Math.max(...(row[index] ?? '').split('\n').map((l) => l.length), 0),
      ),
    );
    sheet.getColumn(index + 1).width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest + 2));
  });
  if (table.columns.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: table.columns.length },
    };
  }
}

/**
 * Dossier d'analyse en Excel (`exceljs`, spécification 6.4) : une feuille de présentation, puis
 * une feuille par tableau du document (en-têtes issus du catalogue i18n), même vides. Les dates
 * du classeur sont fixées à `producedAt` : les octets ne dépendent que du document.
 */
export async function renderXlsx(doc: DossierDocument, producedAt: string): Promise<Uint8Array> {
  const date = new Date(producedAt);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Processia';
  workbook.lastModifiedBy = 'Processia';
  workbook.title = `${doc.title} — ${doc.subtitle}`;
  workbook.created = date;
  workbook.modified = date;
  const taken = new Set<string>();

  const overview = workbook.addWorksheet(sheetName(t('exports.sheet.overview'), taken));
  overview.addRow([doc.title]).font = { bold: true, size: 16 };
  overview.addRow([doc.subtitle]);
  overview.addRow([]);
  for (const entry of doc.cover) {
    const row = overview.addRow([entry.label, entry.value]);
    row.getCell(1).font = { bold: true };
    row.alignment = { vertical: 'top', wrapText: true };
  }
  overview.addRow([]);
  for (const notice of doc.notices) {
    const row = overview.addRow([notice]);
    row.getCell(1).font = { italic: true };
    row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    overview.mergeCells(row.number, 1, row.number, 2);
    row.height = 34;
  }
  overview.getColumn(1).width = 28;
  overview.getColumn(2).width = 90;

  for (const table of documentTables(doc)) {
    addTable(workbook, table, sheetName(table.sheet, taken));
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return normalizeZip(new Uint8Array(buffer), date);
}
