import type { TextBlock } from './types.js';

export interface TranscribedPage {
  page: number;
  text: string;
}

/** Blocs de texte d'une transcription par page (pipeline `extraction.document_visual`). */
export function blocksFromPages(pages: TranscribedPage[]): TextBlock[] {
  return [...pages]
    .sort((a, b) => a.page - b.page)
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({
      text: p.text.trim(),
      section: 'visual',
      locator: { kind: 'page' as const, pageStart: p.page, pageEnd: p.page },
    }));
}
