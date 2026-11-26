import type { Chunk, Locator, TextBlock } from './types.js';

/** Environ 6 000 jetons (spécification 4.4) à 4 caractères par jeton. */
export const DEFAULT_CHUNK_CHARS = 24_000;

/** Séparateur entre blocs regroupés dans un même morceau. */
const BLOCK_SEPARATOR = '\n\n';

function columnOf(cell: string): string {
  return cell.replace(/\d+$/, '');
}

function mergeLocators(a: Locator, b: Locator): Locator {
  switch (a.kind) {
    case 'page':
      return b.kind === 'page' ? { ...a, pageEnd: Math.max(a.pageEnd, b.pageEnd) } : a;
    case 'paragraph':
      return b.kind === 'paragraph'
        ? { ...a, paragraphEnd: Math.max(a.paragraphEnd, b.paragraphEnd) }
        : a;
    case 'cell': {
      if (b.kind !== 'cell') return a;
      const first = columnOf(a.range.split(':')[0] ?? 'A');
      const last = columnOf(b.range.split(':').pop() ?? b.range);
      const rowEnd = Math.max(a.rowEnd, b.rowEnd);
      return { ...a, rowEnd, range: `${first}${a.rowStart}:${last}${rowEnd}` };
    }
    case 'line':
      return b.kind === 'line' ? { ...a, lineEnd: Math.max(a.lineEnd, b.lineEnd) } : a;
  }
}

/** Coupe un texte trop long sur la frontière de ligne, de phrase ou d'espace la plus proche. */
export function splitLongText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. ') + 1);
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) parts.push(rest);
  return parts.filter((p) => p.length > 0);
}

/**
 * Regroupe les blocs en morceaux d'au plus `maxChars` caractères, sans jamais mélanger deux
 * sections (feuilles). Un bloc plus long que la limite est coupé : ses morceaux gardent son
 * localisateur. Le localisateur d'un morceau couvre l'étendue des blocs regroupés.
 */
export function chunkBlocks(blocks: TextBlock[], maxChars: number = DEFAULT_CHUNK_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  let currentText = '';
  let currentLocator: Locator | undefined;
  let currentSection: string | undefined;

  const flush = (): void => {
    if (currentLocator !== undefined && currentText.length > 0) {
      chunks.push({ ordinal: chunks.length, text: currentText, locator: currentLocator });
    }
    currentText = '';
    currentLocator = undefined;
    currentSection = undefined;
  };

  for (const block of blocks) {
    const text = block.text.trim();
    if (text.length === 0) continue;
    const pieces = text.length > maxChars ? splitLongText(text, maxChars) : [text];
    for (const piece of pieces) {
      if (
        currentLocator !== undefined &&
        currentSection === block.section &&
        currentText.length + BLOCK_SEPARATOR.length + piece.length <= maxChars
      ) {
        currentText += BLOCK_SEPARATOR + piece;
        currentLocator = mergeLocators(currentLocator, block.locator);
      } else {
        flush();
        currentText = piece;
        currentLocator = block.locator;
        currentSection = block.section;
      }
    }
  }
  flush();
  return chunks;
}
