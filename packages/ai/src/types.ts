import type { z } from 'zod';

export interface AiCapabilities {
  text: boolean;
  documents: boolean;
  images: boolean;
  audio: boolean;
}

export interface AiAttachment {
  kind: 'pdf' | 'image';
  mediaType: string;
  data: Uint8Array;
  name: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StructuredRequest<T> {
  pipeline: string;
  pipelineVersion: string;
  /** Prompt système (fr), stable : favorise le cache de prompt. */
  system: string;
  /** Contexte stable d'une session de travail (résumé du modèle) : second bloc mis en cache. */
  context?: string;
  messages: ChatMessage[];
  /** Documents sans texte exploitable (scans, images). */
  attachments?: AiAttachment[];
  schema: z.ZodType<T>;
  schemaName: string;
  /** 16 000 par défaut ; flux (streaming) au-delà. */
  maxOutputTokens?: number;
  /** Traduit selon le fournisseur. */
  effort?: 'low' | 'medium' | 'high';
  /** Modèle résolu par l'exécuteur depuis la configuration ; jamais écrit en dur. */
  model?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  usage: Usage;
  stopReason: 'end' | 'max_tokens' | 'refusal' | 'other';
  raw: unknown;
  /** Avertissements du fournisseur (ex. repli générique du fournisseur factice). */
  warnings?: string[];
}

export interface AiProvider {
  readonly id: 'fake' | 'anthropic' | (string & {});
  readonly capabilities: AiCapabilities;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
