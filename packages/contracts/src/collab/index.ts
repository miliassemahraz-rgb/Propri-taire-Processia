import { z } from 'zod';
import type { QuestionUpdatedMessage } from '../guided/index.js';
import type {
  CommentCreatedMessage,
  NoticeCreatedMessage,
  SubmissionUpdatedMessage,
} from '../validation/index.js';
import type { RunProgressMessage } from '../sources/index.js';
import type { ProposalUpdatedMessage } from '../model/index.js';

/** Contrats de la coédition (WP-10, spécification 5). */

/** Durée de vie du jeton de coédition : 10 minutes (ADR 0004). */
export const COLLAB_TOKEN_TTL_SECONDS = 600;
export const COLLAB_TOKEN_ISSUER = 'processia-api';
export const COLLAB_TOKEN_AUDIENCE = 'processia-collab';

/** Canal `pg_notify` des nouvelles versions : charge `{ missionId, version }`. */
export const MISSION_EVENTS_CHANNEL = 'mission_events';

export const COLLAB_DOC_KINDS = ['model', 'workspace'] as const;
export type CollabDocKind = (typeof COLLAB_DOC_KINDS)[number];

export const modelDocName = (missionId: string): string => `mission:${missionId}:model`;
export const workspaceDocName = (missionId: string): string => `mission:${missionId}:workspace`;

const DOC_RE =
  /^mission:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(model|workspace)$/i;

/** Décompose un nom de document ; `null` s'il n'est pas de la forme `mission:<id>:<type>`. */
export function parseDocName(name: string): { missionId: string; kind: CollabDocKind } | null {
  const match = DOC_RE.exec(name);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { missionId: match[1].toLowerCase(), kind: match[2] as CollabDocKind };
}

/** Document `model` : `Y.Map` des éléments (clé : id), `Y.Map` de métadonnées (spécification 5.1). */
export const MODEL_ELEMENTS_MAP = 'elements';
export const MODEL_META_MAP = 'meta';
/** Document `workspace` : texte du métier (`Y.XmlFragment`, champ TipTap `default` renommé). */
export const WORKSPACE_DESCRIPTION_FRAGMENT = 'description';

/** Réponse de `POST /missions/:id/collab-token`. */
export const collabTokenResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string(),
  /** URL WebSocket du serveur de coédition. */
  url: z.string().min(1),
  /** Le compte peut écrire dans l'espace de travail (sinon lecture seule). */
  canEdit: z.boolean(),
});
export type CollabTokenResponse = z.infer<typeof collabTokenResponseSchema>;

/** Message sans état `model.version` : une nouvelle version du modèle est dans le `Y.Map`. */
export interface ModelVersionMessage {
  type: 'model.version';
  missionId: string;
  version: number;
}

/** Messages sans état diffusés sur le document `model` (les autres types arriveront avec leurs WP). */
export type CollabStatelessMessage =
  | ModelVersionMessage
  | RunProgressMessage
  | QuestionUpdatedMessage
  | CommentCreatedMessage
  | SubmissionUpdatedMessage
  | NoticeCreatedMessage
  | ProposalUpdatedMessage;

/**
 * Messages sans état du document `workspace` : « enregistrer maintenant ». Le texte est regroupé
 * avant d'être écrit en base (2 s, au plus 10 s) ; « Analyser » demande l'écriture immédiate puis
 * attend `workspace.flushed` avant de figer la description côté API.
 */
export interface WorkspaceFlushRequest {
  type: 'workspace.flush';
  id: string;
}
export interface WorkspaceFlushedMessage {
  type: 'workspace.flushed';
  id: string;
}
