/** Types de l'extraction de texte et du découpage (spécification 4.5 et 4.6). */

export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'image' | 'text';

/** Limite de taille d'un fichier déposé (spécification 4.6) : 50 Mo. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface DetectedFile {
  kind: FileKind;
  /** Type MIME déduit de la signature (jamais de l'extension déclarée). */
  mime: string;
}

/** Localisateur d'un morceau dans le document d'origine (colonne `source_chunks.locator`). */
export type Locator =
  | { kind: 'page'; pageStart: number; pageEnd: number }
  | { kind: 'paragraph'; paragraphStart: number; paragraphEnd: number; heading?: string }
  | { kind: 'cell'; sheet: string; range: string; rowStart: number; rowEnd: number }
  | { kind: 'line'; lineStart: number; lineEnd: number };

/** Bloc de texte brut avant découpage : une page, un paragraphe, une ligne de tableau, une ligne. */
export interface TextBlock {
  text: string;
  /** Les blocs de sections différentes (feuille d'un classeur) ne sont jamais regroupés. */
  section: string;
  locator: Locator;
}

export interface Chunk {
  ordinal: number;
  text: string;
  locator: Locator;
}

export type ExtractionResult =
  | { status: 'ok'; blocks: TextBlock[]; pageCount?: number }
  /** Le document n'a pas de texte exploitable (scan, image) : il faut un fournisseur doté de `documents`. */
  | { status: 'needs_vision'; reason: 'scanned_pdf' | 'image'; pageCount?: number };

export class IngestError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED_FILE_TYPE' | 'FILE_TOO_LARGE' | 'CORRUPT_FILE',
    message: string,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}
