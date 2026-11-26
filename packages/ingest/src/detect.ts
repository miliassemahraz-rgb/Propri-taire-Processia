import { fileTypeFromBuffer } from 'file-type';
import { IngestError, MAX_FILE_BYTES, type DetectedFile, type FileKind } from './types.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Types admis par extension : l'extension déclarée doit être cohérente avec la signature. */
const EXTENSION_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  txt: 'text',
  md: 'text',
  markdown: 'text',
};

const TEXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

function isUtf8Text(buffer: Uint8Array): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Détermine le type d'un fichier **par sa signature** (`file-type`) et non par son extension
 * (spécification 4.6, [PO-24]). Une extension incohérente avec la signature, un format non pris
 * en charge ou un fichier trop gros lèvent `IngestError`.
 */
export async function detectFile(buffer: Uint8Array, filename: string): Promise<DetectedFile> {
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new IngestError('FILE_TOO_LARGE', 'Le fichier dépasse 50 Mo.');
  }
  if (buffer.byteLength === 0) {
    throw new IngestError('UNSUPPORTED_FILE_TYPE', 'Le fichier est vide.');
  }
  const ext = extensionOf(filename);
  const declared = EXTENSION_KIND[ext];
  if (declared === undefined) {
    throw new IngestError('UNSUPPORTED_FILE_TYPE', `Extension « ${ext} » non prise en charge.`);
  }

  const detected = await fileTypeFromBuffer(buffer);
  let result: DetectedFile | undefined;
  if (detected === undefined) {
    // Aucune signature binaire : seul un texte brut valide est admis.
    if (declared === 'text' && isUtf8Text(buffer)) {
      result = { kind: 'text', mime: TEXT_MIME[ext] ?? 'text/plain' };
    }
  } else if (detected.mime === 'application/pdf') {
    result = { kind: 'pdf', mime: detected.mime };
  } else if (detected.mime === DOCX_MIME) {
    result = { kind: 'docx', mime: detected.mime };
  } else if (detected.mime === XLSX_MIME) {
    result = { kind: 'xlsx', mime: detected.mime };
  } else if (detected.mime === 'image/png' || detected.mime === 'image/jpeg') {
    result = { kind: 'image', mime: detected.mime };
  }

  if (result === undefined || result.kind !== declared) {
    throw new IngestError(
      'UNSUPPORTED_FILE_TYPE',
      'Le contenu du fichier ne correspond pas à son extension ou à un type pris en charge.',
    );
  }
  return result;
}
