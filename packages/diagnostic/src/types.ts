import type { ElementId, FindingFamily, FindingType } from '@processia/model';

/** Détecteurs déterministes de l'incrément 1 (spécification 4.4, « Décisions sans appel à l'IA »). */
export const DETECTOR_IDS = [
  'task_without_owner',
  'paper_or_email_transfer',
  'rekeying',
  'single_person_dependency',
  'useless_validation_loop',
  'missing_traceability',
] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

/**
 * Constat proposé, avant d'être écrit dans le modèle : produit par un détecteur (`by: 'rule'`) ou
 * par le pipeline `diagnostic` (`by: 'ai'`). `location` désigne des éléments existants du modèle.
 */
export interface FindingCandidate {
  type: FindingType;
  family: FindingFamily;
  /** Au moins un élément du modèle (CDC 4.3 : localisation sur la cartographie). */
  location: ElementId[];
  severity: 1 | 2 | 3;
  label: string;
  /** Justification lisible. */
  evidence: string;
  detection: { by: 'rule' | 'ai'; detectorId?: DetectorId };
}
