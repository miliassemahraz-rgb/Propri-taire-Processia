import { z } from 'zod';
import type { ExportArtifactDto } from '../deliverables/index.js';

/** Contrats du circuit de validation, des commentaires et des signalements (WP-16, spécification 2.7). */

export const SUBMISSION_KINDS = ['analysis_dossier', 'as_is', 'to_be'] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];
export const submissionKindSchema = z.enum(SUBMISSION_KINDS);

export const SUBMISSION_STATUSES = [
  'submitted',
  'validated',
  'superseded',
  'withdrawn',
  'closed',
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** Élément exclu d'un livrable (hypothèse non décidée) : visible du consultant seulement. */
export interface ExcludedHypothesisDto {
  id: string;
  code: string;
  label: string;
  kind: string;
}

export interface SubmissionDto {
  id: string;
  missionId: string;
  kind: SubmissionKind;
  round: number;
  /** Version du modèle figée par la soumission. */
  modelVersion: number;
  status: SubmissionStatus;
  submittedBy: { id: string; name: string };
  submittedAt: string;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  /** Commentaire de la décision, ou note du consultant à la soumission. */
  comment: string | null;
  /** Exports joints (Word, PDF, Excel de la version figée), au fur et à mesure de leur production. */
  exports: ExportArtifactDto[];
  /** Nombre d'hypothèses exclues (le détail n'est donné qu'au consultant). */
  excludedCount: number;
  /** Détail des hypothèses exclues : réservé aux consultants, responsables et administrateurs. */
  excludedHypotheses?: ExcludedHypothesisDto[];
}

export const SUBMISSION_BLOCKERS = ['EMPTY_MODEL', 'WRONG_PHASE', 'ALREADY_VALIDATED'] as const;
export type SubmissionBlocker = (typeof SUBMISSION_BLOCKERS)[number];

/** Aperçu avant soumission : version figée, éléments inclus et hypothèses exclues (CDC 3.4). */
export interface SubmissionPreviewDto {
  kind: SubmissionKind;
  modelVersion: number;
  includedCount: number;
  excludedHypotheses: ExcludedHypothesisDto[];
  /** Soumission en cours (`submitted`) du même type, que la nouvelle remplacerait. */
  replaces: { id: string; round: number } | null;
  /** Raison pour laquelle la soumission est impossible ; `null` si elle est possible. */
  blocker: SubmissionBlocker | null;
}

export const createSubmissionSchema = z.object({
  kind: submissionKindSchema,
  comment: z.string().trim().max(2000).optional(),
});
export type CreateSubmissionRequest = z.infer<typeof createSubmissionSchema>;

export const submissionPreviewQuerySchema = z.object({ kind: submissionKindSchema });

export const decideSubmissionSchema = z.object({
  comment: z.string().trim().max(2000).optional(),
});
export type DecideSubmissionRequest = z.infer<typeof decideSubmissionSchema>;

export interface ValidateSubmissionResult {
  /** Version du modèle produite par la validation (`null` si aucun élément n'a changé). */
  version: number | null;
  validatedCount: number;
  /** Éléments modifiés depuis la version soumise : ils ne passent pas à `validated`. */
  skippedChangedIds: string[];
  /** Phase de la mission après la validation. */
  phase: string;
  submission: SubmissionDto;
}

/** Élément de la version figée, dans la vue du validateur (jamais d'hypothèse). */
export interface SubmissionElementDto {
  id: string;
  code: string;
  label: string;
  kind: string;
  status: string;
}

export const COMMENT_TARGET_KINDS = [
  'element',
  'submission',
  'optimisation',
  'deliverable',
] as const;
export type CommentTargetKind = (typeof COMMENT_TARGET_KINDS)[number];

export const COMMENT_MAX_LENGTH = 4000;

export const createCommentSchema = z.object({
  targetKind: z.enum(COMMENT_TARGET_KINDS),
  /** Identifiant de la soumission, de l'élément, de l'optimisation ou du livrable. */
  targetId: z.string().min(1).max(200),
  /** Soumission dont la version figée est commentée (obligatoire pour un élément ou un livrable). */
  submissionId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  body: z.string().trim().min(1).max(COMMENT_MAX_LENGTH),
});
export type CreateCommentRequest = z.infer<typeof createCommentSchema>;

export const listCommentsSchema = z.object({
  targetKind: z.enum(COMMENT_TARGET_KINDS).optional(),
  targetId: z.string().min(1).max(200).optional(),
});
export type ListCommentsQuery = z.infer<typeof listCommentsSchema>;

export const resolveCommentSchema = z.object({ resolved: z.boolean() });
export type ResolveCommentRequest = z.infer<typeof resolveCommentSchema>;

export interface CommentDto {
  id: string;
  targetKind: CommentTargetKind;
  targetId: string;
  modelVersion: number | null;
  parentId: string | null;
  /** Fil partagé avec le validateur ; `null` : commentaire interne de l'équipe. */
  submissionId: string | null;
  author: { id: string; name: string; role: 'validator' | 'team' };
  body: string;
  createdAt: string;
  resolvedAt: string | null;
}

/** Signalement après validation (CDC 3.6 §3 et 3.7) : un élément validé a été modifié. */
export interface NoticeDto {
  id: string;
  submissionId: string;
  elementId: string;
  version: number;
  summary: string;
  createdAt: string;
  seenAt: string | null;
}

export const markNoticesSeenSchema = z.object({
  noticeIds: z.array(z.string().uuid()).min(1).max(500),
});
export type MarkNoticesSeenRequest = z.infer<typeof markNoticesSeenSchema>;

/** Notification in-app (centre de notifications). */
export interface NotificationDto {
  id: string;
  kind: string;
  missionId: string | null;
  payload: unknown;
  createdAt: string;
  readAt: string | null;
}

export const NOTIFICATION_KINDS = {
  submitted: 'submission.submitted',
  validated: 'submission.validated',
  withdrawn: 'submission.withdrawn',
  comment: 'comment.created',
  postValidation: 'post_validation_notice',
} as const;

/** Message sans état : un commentaire a été ajouté ou résolu (consultants connectés). */
export interface CommentCreatedMessage {
  type: 'comment.created';
  missionId: string;
  targetKind: CommentTargetKind;
  targetId: string;
}

/** Message sans état : une soumission a changé d'état (nouvelle, retirée, validée, remplacée). */
export interface SubmissionUpdatedMessage {
  type: 'submission.updated';
  missionId: string;
  submissionId: string;
  status: SubmissionStatus;
}

/** Message sans état : un signalement après validation a été créé. */
export interface NoticeCreatedMessage {
  type: 'notice.created';
  missionId: string;
  version: number;
}
