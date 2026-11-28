import type { SubmissionBlocker, SubmissionKind } from '@processia/contracts';
import { MISSION_PHASES, type MissionPhase } from '@processia/contracts';
import { deliverableView, type BusinessModel, type Element } from '@processia/model';

/**
 * Éléments qui ne sont jamais « validés » par le client : écarts, constats et optimisations
 * (les optimisations sont décidées une à une, WP-23).
 */
const NEVER_VALIDATED = new Set(['discrepancy', 'finding', 'optimisation']);

/**
 * Éléments livrés au validateur dans une version figée : la vue des livrables (`deliverableView`,
 * sans hypothèse ni écart ouvert) privée des types non validables. C'est la seule porte d'entrée
 * du validateur vers le contenu du modèle (PO-52).
 */
export function deliveredElements(model: BusinessModel): Element[] {
  return Object.values(deliveredModel(model).elements).sort((a, b) =>
    a.code.localeCompare(b.code, 'en', { numeric: true }),
  );
}

/**
 * Le modèle que le validateur lit pour une version figée : la vue des livrables privée des types
 * non validables, sans positions (le validateur n'a que les vues simplifiée et textuelle, WP-21).
 * Les références vers un élément retiré ne sont pas nettoyées une seconde fois : un constat ou une
 * optimisation n'est référencé par aucun élément livré.
 */
export function deliveredModel(model: BusinessModel): BusinessModel {
  const view = deliverableView(model);
  return {
    ...view,
    elements: Object.fromEntries(
      Object.entries(view.elements).filter(([, element]) => !NEVER_VALIDATED.has(element.kind)),
    ),
    layout: {},
  };
}

/** Hypothèses non décidées d'une version : exclues des livrables, listées au consultant. */
export function excludedHypotheses(model: BusinessModel): Element[] {
  return Object.values(model.elements)
    .filter((element) => element.status.value === 'hypothesis')
    .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
}

/** Phase de la mission une fois la soumission validée (`null` : pas de changement de phase). */
export const PHASE_AFTER_VALIDATION: Record<SubmissionKind, MissionPhase | null> = {
  analysis_dossier: 'mapping',
  as_is: 'transformation',
  to_be: null,
};

/** Phase minimale pour soumettre : l'AS-IS suit la cartographie, le TO-BE suit le diagnostic. */
const MIN_PHASE_TO_SUBMIT: Record<SubmissionKind, MissionPhase> = {
  analysis_dossier: 'analysis',
  as_is: 'mapping',
  to_be: 'transformation',
};

export const phaseRank = (phase: string): number => MISSION_PHASES.indexOf(phase as MissionPhase);

/** Raison d'impossibilité de soumettre, ou `null`. */
export function submissionBlocker(input: {
  kind: SubmissionKind;
  phase: string;
  head: number;
  deliveredCount: number;
  alreadyValidated: boolean;
}): SubmissionBlocker | null {
  if (input.alreadyValidated) return 'ALREADY_VALIDATED';
  if (phaseRank(input.phase) < phaseRank(MIN_PHASE_TO_SUBMIT[input.kind])) return 'WRONG_PHASE';
  if (input.head === 0 || input.deliveredCount === 0) return 'EMPTY_MODEL';
  return null;
}
