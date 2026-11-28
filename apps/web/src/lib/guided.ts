import type {
  Correction,
  GuidedRunKind,
  QuestionDto,
  RunProgressMessage,
  RunStatus,
} from '@processia/contracts';
import {
  CONCEPT_OF_KIND,
  CONCEPTS,
  type BusinessModel,
  type Concept,
  type Element,
} from '@processia/model';
import { compareElements } from './analysis';

/** Questionnement guidé, hypothèses et décisions (WP-14) : fonctions pures de l'interface. */

export const GUIDED_KINDS: readonly GuidedRunKind[] = [
  'questions',
  'hypotheses',
  'summary',
  'answer',
  'process_flow',
  'diagnostic',
];

export interface GuidedRunState {
  runId: string;
  kind: GuidedRunKind;
  status: RunStatus;
  progress: number;
  error: string | null;
  sourceId: string | null;
}

export const isGuidedKind = (kind: string): kind is GuidedRunKind =>
  (GUIDED_KINDS as readonly string[]).includes(kind);

export const isRunActive = (run: { status: RunStatus }): boolean =>
  run.status === 'queued' || run.status === 'running';

/**
 * Intègre un message `run.progress` d'un des genres suivis. Un message tardif ne ramène jamais
 * une exécution terminée à l'état actif ; les autres genres sont ignorés.
 */
export function applyGuidedRun(
  runs: Record<string, GuidedRunState>,
  message: RunProgressMessage,
  kinds: readonly GuidedRunKind[] = GUIDED_KINDS,
): Record<string, GuidedRunState> {
  if (!isGuidedKind(message.kind) || !kinds.includes(message.kind)) return runs;
  const current = runs[message.runId];
  if (current !== undefined && !isRunActive(current) && isRunActive(message)) return runs;
  return {
    ...runs,
    [message.runId]: {
      runId: message.runId,
      kind: message.kind,
      status: message.status,
      progress: message.progress,
      error: message.error,
      sourceId: message.sourceId,
    },
  };
}

/** Exécution active d'un genre donné, s'il y en a une. */
export function activeRun(
  runs: Record<string, GuidedRunState>,
  kind: GuidedRunKind,
): GuidedRunState | null {
  return Object.values(runs).find((run) => run.kind === kind && isRunActive(run)) ?? null;
}

// ------------------------------------------------------------------ questions

/** Questions ouvertes, la plus bloquante d'abord (le rang vient du serveur). */
export function openQuestions(questions: QuestionDto[]): QuestionDto[] {
  return questions
    .filter((q) => q.status === 'open')
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
}

/** Concepts « bloqués » par une question : le sien, puis ceux des éléments visés. */
export function blockingConcepts(question: QuestionDto, model: BusinessModel | null): Concept[] {
  const found = new Set<Concept>();
  if ((CONCEPTS as readonly string[]).includes(question.concept)) {
    found.add(question.concept as Concept);
  }
  for (const id of question.targetElementIds) {
    const element = model?.elements[id];
    if (element !== undefined && element.kind in CONCEPT_OF_KIND) {
      found.add(CONCEPT_OF_KIND[element.kind as keyof typeof CONCEPT_OF_KIND]);
    }
  }
  return [...found];
}

// ------------------------------------------------------------------ hypothèses

/** Hypothèses en attente de décision (écarts, constats et optimisations exclus), triées. */
export function pendingHypotheses(model: BusinessModel | null): Element[] {
  if (model === null) return [];
  return Object.values(model.elements)
    .filter((e) => e.status.value === 'hypothesis' && e.kind in CONCEPT_OF_KIND)
    .sort((a, b) => {
      const ca = CONCEPTS.indexOf(CONCEPT_OF_KIND[a.kind as keyof typeof CONCEPT_OF_KIND]);
      const cb = CONCEPTS.indexOf(CONCEPT_OF_KIND[b.kind as keyof typeof CONCEPT_OF_KIND]);
      return ca - cb || compareElements(a, b);
    });
}

/** Contenu principal d'un élément, pour l'afficher sous son libellé. */
export function elementDetail(element: Element): string {
  switch (element.kind) {
    case 'business_trait':
      return element.text;
    case 'glossary_term':
      return element.definition;
    case 'actor':
      return element.responsibilities.join(' ; ');
    case 'rule':
      return element.statement.text;
    default:
      return element.description ?? '';
  }
}

export type CorrectionField = keyof Correction;

/** Attributs textuels d'un élément d'analyse corrigeables par formulaire [PO-5]. */
export function correctableFields(kind: Element['kind']): CorrectionField[] {
  switch (kind) {
    case 'business_trait':
      return ['label', 'text', 'description'];
    case 'glossary_term':
      return ['label', 'definition', 'description'];
    case 'actor':
      return ['label', 'responsibilities', 'description'];
    case 'activity':
    case 'tool':
      return ['label', 'description'];
    default:
      return [];
  }
}

/** Valeurs de départ du formulaire de correction. */
export function correctionDefaults(element: Element): Record<CorrectionField, string> {
  const base = element as unknown as Record<string, unknown>;
  return {
    label: element.label,
    description: element.description ?? '',
    text: typeof base['text'] === 'string' ? base['text'] : '',
    definition: typeof base['definition'] === 'string' ? base['definition'] : '',
    responsibilities: Array.isArray(base['responsibilities'])
      ? (base['responsibilities'] as string[]).join('\n')
      : '',
  };
}

/** Correction à envoyer : seulement les champs que le consultant a réellement modifiés. */
export function buildCorrection(
  element: Element,
  values: Record<CorrectionField, string>,
): Correction {
  const initial = correctionDefaults(element);
  const correction: Correction = {};
  for (const field of correctableFields(element.kind)) {
    const value = values[field].trim();
    if (value === initial[field].trim()) continue;
    if (field === 'responsibilities') {
      correction.responsibilities = value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    } else {
      correction[field] = value;
    }
  }
  return correction;
}

/** La synthèse du métier s'écrit à partir des caractéristiques non hypothétiques (CDC 3.1). */
export function canSummarize(model: BusinessModel | null): boolean {
  if (model === null) return false;
  return Object.values(model.elements).some(
    (e) => e.kind === 'business_trait' && e.facet !== 'summary' && e.status.value !== 'hypothesis',
  );
}
