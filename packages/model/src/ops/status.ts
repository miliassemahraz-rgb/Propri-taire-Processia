import type { ElementStatus, StatusInfo } from '../schema/provenance.js';
import type { StatusActor } from './types.js';

/** Cible d'une transition : un statut, ou le rejet d'une hypothèse (retrait du modèle). */
export type TransitionTarget = ElementStatus | 'rejected';

export interface TransitionContext {
  actor: StatusActor;
  userId?: string;
  at: string;
  /** Création : l'élément porte au moins une `SourceRef` (vérifiée côté serveur). */
  hasVerifiedSource?: boolean;
  /** Création : l'élément porte une justification (`rationale`). */
  hasRationale?: boolean;
  /** Correction : valeur précédente conservée dans `status.correction`. */
  correction?: { previous: unknown; note?: string };
  /** Passage à `validated` : soumission de validation concernée. */
  submissionId?: string;
  /** Retour de `validated` à `confirmed` : version du modèle qui contient la modification. */
  version?: number;
}

export type TransitionErrorCode =
  | 'FORBIDDEN_TRANSITION'
  | 'FORBIDDEN_ACTOR'
  | 'MISSING_SOURCE'
  | 'MISSING_RATIONALE'
  | 'MISSING_SUBMISSION'
  | 'MISSING_VERSION';

export type TransitionResult =
  | { ok: true; rejected: false; status: StatusInfo }
  | { ok: true; rejected: true }
  | { ok: false; code: TransitionErrorCode; message: string };

const fail = (code: TransitionErrorCode, message: string): TransitionResult => ({
  ok: false,
  code,
  message,
});

const HUMAN: readonly StatusActor[] = ['consultant', 'mission_lead'];

/**
 * Transitions de statut (spécification 2.1). `current` est `null` pour un élément nouveau.
 *
 * | De → vers                           | Qui                           | Condition                         |
 * | (nouveau) → extracted               | système, IA                   | une source vérifiée               |
 * | (nouveau) → hypothesis              | système, IA                   | une justification                 |
 * | (nouveau) → confirmed [écart]       | consultant, responsable       | création par dialogue (voir WP-03)|
 * | extracted, hypothesis → confirmed   | consultant, responsable       |                                   |
 * | hypothesis → rejeté                 | consultant, responsable       | retrait du modèle                 |
 * | extracted, confirmed → validated    | validateur                    | soumission de validation          |
 * | validated → confirmed               | système                       | modification du contenu           |
 *
 * Toute autre transition est interdite (dont rester dans le même statut).
 */
export function transitionStatus(
  current: StatusInfo | null,
  to: TransitionTarget,
  ctx: TransitionContext,
): TransitionResult {
  const from: ElementStatus | null = current?.value ?? null;
  const label = `${from ?? '(nouveau)'} → ${to}`;
  const forbidden = () => fail('FORBIDDEN_TRANSITION', `Transition interdite : ${label}`);
  const actorOk = (allowed: readonly StatusActor[]): boolean => allowed.includes(ctx.actor);
  const base = (value: ElementStatus): StatusInfo => {
    const s: StatusInfo = { value };
    return s;
  };

  if (from === null) {
    if (to === 'extracted') {
      if (!actorOk(['system', 'ai']))
        return fail('FORBIDDEN_ACTOR', `${label} : réservé au système ou à l'IA`);
      if (!ctx.hasVerifiedSource)
        return fail('MISSING_SOURCE', `${label} : source vérifiée requise`);
      return { ok: true, rejected: false, status: base('extracted') };
    }
    if (to === 'hypothesis') {
      if (!actorOk(['system', 'ai']))
        return fail('FORBIDDEN_ACTOR', `${label} : réservé au système ou à l'IA`);
      if (!ctx.hasRationale) return fail('MISSING_RATIONALE', `${label} : justification requise`);
      return { ok: true, rejected: false, status: base('hypothesis') };
    }
    if (to === 'confirmed') {
      if (!actorOk(HUMAN)) return fail('FORBIDDEN_ACTOR', `${label} : réservé au consultant`);
      return {
        ok: true,
        rejected: false,
        status: {
          value: 'confirmed',
          ...(ctx.userId ? { decidedBy: ctx.userId } : {}),
          decidedAt: ctx.at,
        },
      };
    }
    return forbidden();
  }

  if ((from === 'extracted' || from === 'hypothesis') && to === 'confirmed') {
    if (!actorOk(HUMAN)) return fail('FORBIDDEN_ACTOR', `${label} : réservé au consultant`);
    const status: StatusInfo = {
      value: 'confirmed',
      ...(ctx.userId ? { decidedBy: ctx.userId } : {}),
      decidedAt: ctx.at,
      ...(ctx.correction ? { correction: ctx.correction } : {}),
    };
    return { ok: true, rejected: false, status };
  }

  if (from === 'hypothesis' && to === 'rejected') {
    if (!actorOk(HUMAN)) return fail('FORBIDDEN_ACTOR', `${label} : réservé au consultant`);
    return { ok: true, rejected: true };
  }

  if ((from === 'extracted' || from === 'confirmed') && to === 'validated') {
    if (!actorOk(['validator'])) return fail('FORBIDDEN_ACTOR', `${label} : réservé au validateur`);
    if (!ctx.submissionId) return fail('MISSING_SUBMISSION', `${label} : soumission requise`);
    return {
      ok: true,
      rejected: false,
      status: {
        value: 'validated',
        ...(ctx.userId ? { decidedBy: ctx.userId } : {}),
        decidedAt: ctx.at,
        validatedInSubmission: ctx.submissionId,
      },
    };
  }

  if (from === 'validated' && to === 'confirmed') {
    if (!actorOk(['system'])) return fail('FORBIDDEN_ACTOR', `${label} : réservé au système`);
    if (ctx.version === undefined) return fail('MISSING_VERSION', `${label} : version requise`);
    return {
      ok: true,
      rejected: false,
      status: {
        value: 'confirmed',
        changedAfterValidation: { version: ctx.version, at: ctx.at },
      },
    };
  }

  return forbidden();
}
