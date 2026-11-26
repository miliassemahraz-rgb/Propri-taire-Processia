import * as Y from 'yjs';

function nodeText(node: unknown): string {
  if (node instanceof Y.XmlText) {
    return node
      .toDelta()
      .map((part: { insert?: unknown }) => (typeof part.insert === 'string' ? part.insert : ''))
      .join('');
  }
  if (node instanceof Y.XmlElement) {
    if (node.nodeName === 'hardBreak') return '\n';
    const children = node.toArray();
    // Listes et blocs imbriqués : une ligne par enfant ; sinon texte continu.
    const nested = children.some((child) => child instanceof Y.XmlElement);
    return children.map(nodeText).join(nested ? '\n' : '');
  }
  return '';
}

/**
 * Texte brut de la description du métier (`Y.XmlFragment` `description` du document `workspace`) :
 * un paragraphe par nœud de premier niveau, séparés par une ligne vide (spécification 5.1).
 */
export function descriptionTextFromState(state: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return doc
      .getXmlFragment('description')
      .toArray()
      .map(nodeText)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0)
      .join('\n\n');
  } finally {
    doc.destroy();
  }
}

/** Nom du document Yjs de l'espace de travail d'une mission (spécification 5.1). */
export const workspaceDocName = (missionId: string): string => `mission:${missionId}:workspace`;
