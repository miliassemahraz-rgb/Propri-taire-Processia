import type { Concept } from '../schema/kinds.js';
import type { ElementId } from '../schema/ids.js';

/** Rôle de l'acteur qui exécute une opération (spécification 2.1, tableau des transitions). */
export type StatusActor = 'ai' | 'system' | 'consultant' | 'mission_lead' | 'validator';

export type IntegrityErrorCode =
  | 'STALE_BASE_VERSION'
  | 'UNKNOWN_TEMP_ID'
  | 'DUPLICATE_TEMP_ID'
  | 'ID_COLLISION'
  | 'UNKNOWN_ELEMENT'
  | 'SCHEMA_VIOLATION'
  | 'DUPLICATE_CODE'
  | 'IMMUTABLE_FIELD'
  | 'FORBIDDEN_TRANSITION'
  | 'NOT_A_HYPOTHESIS'
  | 'REFERENCED_ELEMENT'
  | 'UNKNOWN_REFERENCE';

export interface IntegrityError {
  code: IntegrityErrorCode;
  message: string;
  /** Rang de l'opération fautive dans le ChangeSet, si elle est identifiable. */
  opIndex?: number;
  elementId?: ElementId;
  /** Chemin dans l'élément (ex. `raci[].actorId`) ou dans le schéma. */
  path?: string;
  /** Élément visé par une référence (supprimé ou inconnu). */
  targetId?: ElementId;
}

export type CoherenceCode =
  | 'ACTIVITY_WITHOUT_OWNER'
  | 'DEAD_END_BRANCH'
  | 'DATA_NEVER_PRODUCED'
  | 'UNREACHABLE_NODE'
  | 'GATEWAY_SINGLE_OUTGOING'
  | 'DECISION_WITHOUT_RULE'
  | 'PROCESS_WITHOUT_START_OR_END'
  | 'FLOW_UNKNOWN_CHANNEL'
  | 'ORPHAN_DATA_OBJECT'
  | 'RULE_WITHOUT_SCOPE';

/** Avertissement de cohérence : affiché, n'empêche jamais l'enregistrement (CDC 4.2). */
export interface CoherenceIssue {
  code: CoherenceCode;
  severity: 'warning';
  elementId: ElementId;
  message: string;
  relatedIds?: ElementId[];
}

export interface ModelDiff {
  added: ElementId[];
  removed: ElementId[];
  /** Champs de premier niveau modifiés (hors `meta`), par élément. */
  modified: { id: ElementId; fields: string[] }[];
  /** Diagrammes dont la disposition a changé. */
  layout: string[];
}

export interface CompletenessGap {
  check: string;
  message: string;
  elementId?: ElementId;
}

export interface CompletenessReport {
  /** Contrôles satisfaits / contrôles applicables, dans [0, 1] (au moins un contrôle applicable). */
  score: number;
  satisfied: number;
  applicable: number;
  gaps: CompletenessGap[];
  pendingHypotheses: number;
  openQuestions: number;
}

export type CompletenessByConcept = Record<Concept, CompletenessReport>;

export type RaciRole = 'R' | 'A' | 'C' | 'I';

export interface RaciMatrix {
  actors: { id: ElementId; code: string; label: string }[];
  rows: {
    activityId: ElementId;
    code: string;
    label: string;
    level: string;
    roles: Record<ElementId, RaciRole[]>;
  }[];
}

export interface ApplyOptions {
  /** Générateur d'identifiants persistants (UUID v7). Par défaut : dérivation déterministe. */
  newId?: () => string;
  /** Instant des décisions de statut. Par défaut : epoch Unix (l'appelant fournit l'horloge). */
  at?: string;
  /** Auteur des décisions de statut. */
  userId?: string;
  /** Rôle appliqué aux `set_status` / `reject_hypothesis`. Par défaut `consultant`. */
  actor?: StatusActor;
  /** Soumission de validation, exigée pour passer un élément à `validated`. */
  submissionId?: string;
}
