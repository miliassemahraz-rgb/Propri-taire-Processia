import {
  SUBMISSION_KINDS,
  type CommentDto,
  type CommentTargetKind,
  type NotificationDto,
  type SubmissionDto,
  type SubmissionKind,
} from '@processia/contracts';

/** Circuit de validation (WP-16) : fonctions pures de l'interface. */

export type StepState = 'validated' | 'pending' | 'toSubmit' | 'soon';

export interface Step {
  kind: SubmissionKind;
  state: StepState;
  /** Soumission la plus récente du type (hors retirée), si elle existe. */
  submission: SubmissionDto | null;
}

/** Soumission la plus récente non retirée d'un type. */
export function latestOf(
  submissions: readonly SubmissionDto[],
  kind: SubmissionKind,
): SubmissionDto | null {
  const found = submissions
    .filter((s) => s.kind === kind && s.status !== 'withdrawn')
    .sort((a, b) => b.round - a.round);
  return found[0] ?? null;
}

/**
 * Étapes de la validation : dossier d'analyse, AS-IS, TO-BE. Une étape est « à soumettre » quand
 * la précédente est validée, « à venir » avant, « en cours de validation » dès qu'une soumission
 * attend la décision du validateur.
 */
export function validationSteps(submissions: readonly SubmissionDto[]): Step[] {
  let previousValidated = true;
  return SUBMISSION_KINDS.map((kind) => {
    const submission = latestOf(submissions, kind);
    const state: StepState =
      submission?.status === 'validated' || submission?.status === 'closed'
        ? 'validated'
        : submission?.status === 'submitted'
          ? 'pending'
          : previousValidated
            ? 'toSubmit'
            : 'soon';
    previousValidated = state === 'validated';
    return { kind, state, submission };
  });
}

/** Soumission affichée par défaut : celle qui attend une décision, sinon la plus récente. */
export function defaultSubmission(submissions: readonly SubmissionDto[]): SubmissionDto | null {
  const visible = submissions.filter((s) => s.status !== 'withdrawn');
  const waiting = visible.filter((s) => s.status === 'submitted').sort((a, b) => b.round - a.round);
  if (waiting[0] !== undefined) return waiting[0];
  const byRecent = [...visible].sort(
    (a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt) || b.round - a.round,
  );
  return byRecent[0] ?? null;
}

export interface Thread {
  root: CommentDto;
  replies: CommentDto[];
}

/** Fils (commentaire racine puis réponses par ordre chronologique) d'une cible. */
export function threadsFor(
  comments: readonly CommentDto[],
  submissionId: string,
  targetKind: CommentTargetKind,
  targetId: string,
): Thread[] {
  const scoped = comments.filter(
    (c) =>
      c.submissionId === submissionId && c.targetKind === targetKind && c.targetId === targetId,
  );
  const byDate = (a: CommentDto, b: CommentDto): number =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
  return scoped
    .filter((c) => c.parentId === null)
    .sort(byDate)
    .map((root) => ({
      root,
      replies: scoped.filter((c) => c.parentId === root.id).sort(byDate),
    }));
}

/** Nombre de commentaires d'une cible (racines et réponses). */
export function commentCount(
  comments: readonly CommentDto[],
  submissionId: string,
  targetKind: CommentTargetKind,
  targetId: string,
): number {
  return comments.filter(
    (c) =>
      c.submissionId === submissionId && c.targetKind === targetKind && c.targetId === targetId,
  ).length;
}

/** Notifications non lues. */
export const unreadCount = (items: readonly NotificationDto[]): number =>
  items.filter((n) => n.readAt === null).length;

/** Lien d'une notification : la page de validation de sa mission. */
export function notificationHref(item: NotificationDto): string | null {
  if (item.missionId === null) return null;
  return `/missions/${item.missionId}/validation`;
}

/** Valeur de la charge utile d'une notification, en texte. */
export function payloadText(payload: unknown, key: string): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** Nombre d'éléments d'une charge utile de signalement. */
export function payloadCount(payload: unknown, key: string): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.length : 0;
}
