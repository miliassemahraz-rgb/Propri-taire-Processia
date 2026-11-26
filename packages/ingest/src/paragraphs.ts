import type { TextBlock } from './types.js';

/** Blocs d'un texte libre (description, réponse) : un bloc par paragraphe séparé par une ligne vide. */
export function blocksFromParagraphs(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let index = 0;
  for (const part of text.split(/\n\s*\n/)) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    index += 1;
    blocks.push({
      text: trimmed,
      section: 'free',
      locator: { kind: 'paragraph', paragraphStart: index, paragraphEnd: index },
    });
  }
  return blocks;
}
