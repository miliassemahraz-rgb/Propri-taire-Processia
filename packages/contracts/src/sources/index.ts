import { z } from 'zod';

/** Contrats des sources : dépôt, extraction, morceaux, progression (WP-11). */

export const SOURCE_KINDS = ['free_text', 'answer', 'document'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * État de l'extraction du texte : `pending` (en file), `extracted`, `unreadable` (scan ou image
 * sans fournisseur doté de `documents` : signalé), `failed` (erreur d'extraction).
 */
export const TEXT_STATUSES = ['pending', 'extracted', 'unreadable', 'failed'] as const;
export type TextStatus = (typeof TEXT_STATUSES)[number];

/** Limite de taille d'un fichier déposé : 50 Mo (spécification 4.6). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Durée de validité d'une URL présignée : 5 minutes (spécification 1.1). */
export const PRESIGNED_URL_TTL_SECONDS = 300;

/** Localisateur d'un morceau (page, paragraphe, feuille et cellules, ligne). */
export type ChunkLocator =
  | { kind: 'page'; pageStart: number; pageEnd: number }
  | { kind: 'paragraph'; paragraphStart: number; paragraphEnd: number; heading?: string }
  | { kind: 'cell'; sheet: string; range: string; rowStart: number; rowEnd: number }
  | { kind: 'line'; lineStart: number; lineEnd: number };

export interface SourceDto {
  id: string;
  kind: SourceKind;
  title: string;
  revision: number;
  mime: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  textStatus: TextStatus;
  createdBy: string | null;
  createdAt: string;
  chunkCount: number;
}

/** Réponse au dépôt d'un document : la source et l'exécution d'extraction suivie par `run.progress`. */
export interface UploadSourceResult {
  source: SourceDto;
  runId: string;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface RunDto {
  id: string;
  kind: string;
  status: RunStatus;
  progress: number;
  error: string | null;
}

export interface ChunkDto {
  id: string;
  ordinal: number;
  text: string;
  locator: ChunkLocator | null;
}

/** Surlignage demandé par positions de caractères dans le texte du morceau. */
export const highlightQuerySchema = z
  .object({
    charStart: z.coerce.number().int().nonnegative().optional(),
    charEnd: z.coerce.number().int().positive().optional(),
  })
  .refine((q) => (q.charStart === undefined) === (q.charEnd === undefined), {
    message: 'charStart et charEnd vont ensemble.',
  })
  .refine((q) => q.charStart === undefined || q.charEnd === undefined || q.charStart < q.charEnd, {
    message: 'charStart doit précéder charEnd.',
  });
export type HighlightQuery = z.infer<typeof highlightQuerySchema>;

export interface ChunkViewDto {
  source: Pick<SourceDto, 'id' | 'kind' | 'title' | 'revision'>;
  chunk: ChunkDto;
  previousOrdinal: number | null;
  nextOrdinal: number | null;
  /** Texte découpé autour du passage surligné, si `charStart` et `charEnd` sont fournis. */
  highlight: {
    charStart: number;
    charEnd: number;
    before: string;
    match: string;
    after: string;
  } | null;
}

export interface PresignedUrlDto {
  url: string;
  expiresInSeconds: number;
  filename: string;
}

/**
 * Message `run.progress` diffusé sur le canal PostgreSQL `mission_messages` (spécification 5.1) :
 * le serveur de coédition le relaie aux clients du document `model` de la mission.
 */
export interface RunProgressMessage {
  type: 'run.progress';
  missionId: string;
  runId: string;
  kind: string;
  status: RunStatus;
  progress: number;
  sourceId: string | null;
  error: string | null;
}

/** Canal `pg_notify` des messages sans état à relayer par le serveur de coédition. */
export const MISSION_MESSAGES_CHANNEL = 'mission_messages';
