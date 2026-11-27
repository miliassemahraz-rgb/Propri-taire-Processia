import type { DocTable, DossierDocument } from '@processia/contracts';
import { t } from '@processia/i18n';
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { normalizeZip } from '../zip.js';

/** A4 en paysage, marges de 1,27 cm : largeur utile en vingtièmes de point. */
const USABLE_WIDTH = 16838 - 2 * 720;
const FONT = 'Calibri';
const HEADER_FILL = 'E4E9F4';
const BODY_SIZE = 20;
const TABLE_SIZE = 16;
const MIN_WEIGHT = 6;
const MAX_WEIGHT = 48;

/** Lignes d'une cellule : `\n` sépare des paragraphes. */
const lines = (value: string): string[] => (value === '' ? [''] : value.split('\n'));

function cell(
  value: string,
  width: number,
  options: { header?: boolean; bold?: boolean },
): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: { top: 40, bottom: 40, left: 70, right: 70 },
    ...(options.header === true
      ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: HEADER_FILL } }
      : {}),
    children: lines(value).map(
      (line) =>
        new Paragraph({
          spacing: { after: 0 },
          children: [
            new TextRun({
              text: line,
              font: FONT,
              size: TABLE_SIZE,
              bold: options.header === true || options.bold === true,
            }),
          ],
        }),
    ),
  });
}

/** Largeurs de colonnes proportionnelles au contenu (bornées), somme = largeur utile. */
export function columnWidths(table: DocTable): number[] {
  const weights = table.columns.map((header, index) => {
    const longest = Math.max(
      header.length,
      ...table.rows.map((row) => Math.max(...lines(row[index] ?? '').map((l) => l.length), 0)),
    );
    return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, longest));
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  const widths = weights.map((w) => Math.floor((w / total) * USABLE_WIDTH));
  widths[widths.length - 1] = USABLE_WIDTH - widths.slice(0, -1).reduce((s, w) => s + w, 0);
  return widths;
}

function tableOf(table: DocTable): Table {
  const widths = columnWidths(table);
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: table.columns.map((column, i) => cell(column, widths[i] ?? 0, { header: true })),
  });
  const body = table.rows.map(
    (row) =>
      new TableRow({
        cantSplit: true,
        children: table.columns.map((_, i) =>
          cell(row[i] ?? '', widths[i] ?? 0, { bold: table.rowHeader && i === 0 }),
        ),
      }),
  );
  return new Table({
    width: { size: USABLE_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: [header, ...body],
  });
}

const heading = (
  text: string,
  level: (typeof HeadingLevel)[keyof typeof HeadingLevel],
  page = false,
) =>
  new Paragraph({
    heading: level,
    pageBreakBefore: page,
    spacing: { before: 240, after: 120 },
    keepNext: true,
    children: [new TextRun({ text, font: FONT })],
  });

const body = (text: string, italics = false): Paragraph =>
  new Paragraph({
    spacing: { after: 100 },
    children: [new TextRun({ text, font: FONT, size: BODY_SIZE, italics })],
  });

type Child = Paragraph | Table;

function sectionChildren(
  doc: DossierDocument,
  section: DossierDocument['annex'],
  pageBreak: boolean,
): Child[] {
  const children: Child[] = [heading(section.title, HeadingLevel.HEADING_1, pageBreak)];
  for (const block of section.blocks) {
    if (block.type === 'paragraph') children.push(body(block.text));
    else if (block.type === 'note') children.push(body(block.text, true));
    else {
      children.push(heading(block.table.caption, HeadingLevel.HEADING_2));
      children.push(
        block.table.rows.length === 0 ? body(block.table.empty, true) : tableOf(block.table),
      );
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
    }
  }
  return children;
}

/**
 * Dossier d'analyse en Word (`docx`, spécification 6.4). Titres de niveaux 1 et 2 (navigation),
 * en-têtes de tableau répétés, A4 paysage. Les octets ne dépendent que du document : dates du
 * paquet fixées à `producedAt`.
 */
export async function renderDocx(doc: DossierDocument, producedAt: string): Promise<Uint8Array> {
  const date = new Date(producedAt);
  const cover: Child[] = [
    new Paragraph({
      spacing: { before: 1200, after: 160 },
      children: [new TextRun({ text: doc.title, font: FONT, size: 56, bold: true })],
    }),
    new Paragraph({
      spacing: { after: 400 },
      children: [new TextRun({ text: doc.subtitle, font: FONT, size: 30 })],
    }),
    ...doc.cover.map(
      (entry) =>
        new Paragraph({
          spacing: { after: 80 },
          children: [
            new TextRun({ text: `${entry.label} : `, font: FONT, size: BODY_SIZE, bold: true }),
            new TextRun({ text: entry.value, font: FONT, size: BODY_SIZE }),
          ],
        }),
    ),
    new Paragraph({ spacing: { after: 200 }, children: [] }),
    ...doc.notices.map((notice) => body(notice, true)),
  ];
  const sections = [
    ...doc.deliverables.map((section) => sectionChildren(doc, section, true)),
    sectionChildren(doc, doc.annex, true),
  ].flat();
  const document = new Document({
    creator: 'Processia',
    lastModifiedBy: 'Processia',
    title: `${doc.title} — ${doc.subtitle}`,
    description: doc.title,
    styles: {
      default: {
        document: { run: { font: FONT, size: BODY_SIZE, language: { value: 'fr-FR' } } },
      },
      paragraphStyles: [
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { font: FONT, size: 32, bold: true, color: '1F3A8A' },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { font: FONT, size: 24, bold: true, color: '1A1D23' },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    font: FONT,
                    size: 16,
                    children: [
                      `${doc.title} · ${t('exports.document.page')}`,
                      PageNumber.CURRENT,
                      t('exports.document.pageOf'),
                      PageNumber.TOTAL_PAGES,
                    ],
                  }),
                ],
              }),
            ],
          }),
        },
        children: [...cover, ...sections],
      },
    ],
  });
  const bytes = await Packer.toBuffer(document);
  return normalizeZip(bytes, date);
}
