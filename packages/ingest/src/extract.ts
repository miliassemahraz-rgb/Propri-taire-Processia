import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { IngestError, type ExtractionResult, type FileKind, type TextBlock } from './types.js';

/** Un PDF dont le texte moyen par page est inférieur à ce seuil est traité comme un scan. */
const MIN_CHARS_PER_PAGE = 20;

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeHtml(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function stripTags(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

export async function extractPdf(data: Uint8Array): Promise<ExtractionResult> {
  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const result = await extractText(pdf, { mergePages: false });
    pages = result.text;
  } catch (error) {
    throw new IngestError('CORRUPT_FILE', `PDF illisible : ${(error as Error).message}`);
  }
  const total = pages.reduce((sum, page) => sum + page.trim().length, 0);
  if (pages.length === 0 || total < MIN_CHARS_PER_PAGE * pages.length) {
    return { status: 'needs_vision', reason: 'scanned_pdf', pageCount: pages.length };
  }
  const blocks: TextBlock[] = [];
  pages.forEach((text, index) => {
    const page = index + 1;
    if (text.trim().length === 0) return;
    blocks.push({
      text: text.trim(),
      section: 'pdf',
      locator: { kind: 'page', pageStart: page, pageEnd: page },
    });
  });
  return { status: 'ok', blocks, pageCount: pages.length };
}

/** DOCX : titres et paragraphes (cellules de tableau comprises), numérotés dans l'ordre. */
export async function extractDocx(data: Uint8Array): Promise<ExtractionResult> {
  let html: string;
  try {
    html = (await mammoth.convertToHtml({ buffer: Buffer.from(data) })).value;
  } catch (error) {
    throw new IngestError('CORRUPT_FILE', `DOCX illisible : ${(error as Error).message}`);
  }
  const blocks: TextBlock[] = [];
  let heading: string | undefined;
  let paragraph = 0;
  for (const match of html.matchAll(/<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const tag = match[1] ?? 'p';
    const text = stripTags(match[2] ?? '');
    if (text.length === 0) continue;
    paragraph += 1;
    if (tag.startsWith('h')) heading = text;
    blocks.push({
      text,
      section: 'docx',
      locator: {
        kind: 'paragraph',
        paragraphStart: paragraph,
        paragraphEnd: paragraph,
        ...(heading === undefined ? {} : { heading }),
      },
    });
  }
  return { status: 'ok', blocks };
}

function columnLetter(index: number): string {
  let n = index;
  let letters = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** XLSX : une ligne de tableau forme un bloc ; les en-têtes de la première ligne nomment les valeurs. */
export async function extractXlsx(data: Uint8Array): Promise<ExtractionResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
  } catch (error) {
    throw new IngestError('CORRUPT_FILE', `XLSX illisible : ${(error as Error).message}`);
  }
  const blocks: TextBlock[] = [];
  for (const sheet of workbook.worksheets) {
    let headers: Map<number, string> | undefined;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: { col: number; text: string }[] = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const text = cell.text.trim();
        if (text.length > 0) cells.push({ col, text });
      });
      if (cells.length === 0) return;
      const first = cells[0]?.col ?? 1;
      const last = cells[cells.length - 1]?.col ?? first;
      let text: string;
      if (headers === undefined) {
        headers = new Map(cells.map((c) => [c.col, c.text]));
        text = cells.map((c) => c.text).join(' | ');
      } else {
        const known = headers;
        text = cells
          .map((c) => {
            const header = known.get(c.col);
            return header === undefined ? c.text : `${header} : ${c.text}`;
          })
          .join(' | ');
      }
      blocks.push({
        text,
        section: sheet.name,
        locator: {
          kind: 'cell',
          sheet: sheet.name,
          range: `${columnLetter(first)}${rowNumber}:${columnLetter(last)}${rowNumber}`,
          rowStart: rowNumber,
          rowEnd: rowNumber,
        },
      });
    });
  }
  return { status: 'ok', blocks };
}

/** TXT et MD : blocs séparés par une ligne vide, localisés par numéros de ligne. */
export function extractPlainText(data: Uint8Array): ExtractionResult {
  const lines = new TextDecoder('utf-8')
    .decode(data)
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/);
  const blocks: TextBlock[] = [];
  let start: number | undefined;
  let buffer: string[] = [];
  const flush = (end: number): void => {
    if (start !== undefined && buffer.length > 0) {
      blocks.push({
        text: buffer.join('\n'),
        section: 'text',
        locator: { kind: 'line', lineStart: start, lineEnd: end },
      });
    }
    start = undefined;
    buffer = [];
  };
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim().length === 0) {
      flush(lineNumber - 1);
      return;
    }
    start ??= lineNumber;
    buffer.push(line);
  });
  flush(lines.length);
  return { status: 'ok', blocks };
}

/** Extrait le texte d'un fichier déjà identifié par `detectFile`. */
export async function extractDocumentText(
  kind: FileKind,
  data: Uint8Array,
): Promise<ExtractionResult> {
  switch (kind) {
    case 'pdf':
      return extractPdf(data);
    case 'docx':
      return extractDocx(data);
    case 'xlsx':
      return extractXlsx(data);
    case 'text':
      return extractPlainText(data);
    case 'image':
      return { status: 'needs_vision', reason: 'image' };
  }
}
