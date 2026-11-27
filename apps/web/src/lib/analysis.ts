import type { RunProgressMessage, RunStatus, SourceDto } from '@processia/contracts';
import {
  CONCEPT_OF_KIND,
  CONCEPTS,
  type BusinessModel,
  type Discrepancy,
  type Element,
  type ElementStatus,
  type SourceRef,
} from '@processia/model';

/** Onglets de l'espace Analyse : les sept concepts, puis les écarts entre sources. */
export const ANALYSIS_TABS = [...CONCEPTS, 'discrepancies'] as const;
export type AnalysisTab = (typeof ANALYSIS_TABS)[number];

type ConceptKind = keyof typeof CONCEPT_OF_KIND;

/** Tri naturel par code (`P04.2` avant `P04.10`), puis par libellé. */
export function compareElements(a: Element, b: Element): number {
  const byCode = a.code.localeCompare(b.code, 'fr', { numeric: true });
  return byCode !== 0 ? byCode : a.label.localeCompare(b.label, 'fr');
}

/** Éléments du modèle regroupés par onglet, triés ; les constats et optimisations n'y figurent pas. */
export function elementsByTab(model: BusinessModel | null): Record<AnalysisTab, Element[]> {
  const result = Object.fromEntries(ANALYSIS_TABS.map((tab) => [tab, [] as Element[]])) as Record<
    AnalysisTab,
    Element[]
  >;
  if (model === null) return result;
  for (const element of Object.values(model.elements)) {
    if (element.kind === 'discrepancy') result.discrepancies.push(element);
    else if (element.kind in CONCEPT_OF_KIND) {
      result[CONCEPT_OF_KIND[element.kind as ConceptKind]].push(element);
    }
  }
  for (const list of Object.values(result)) list.sort(compareElements);
  return result;
}

/** Références de source portées par un élément (provenance, et côtés d'un écart). */
export function refsOf(element: Element): SourceRef[] {
  const refs = [...element.provenance.refs];
  if (element.kind === 'discrepancy') for (const side of element.sides) refs.push(...side.refs);
  return refs;
}

/** Nombre d'éléments qui citent chaque source (« 48 éléments extraits »). */
export function citationCountBySource(model: BusinessModel | null): Map<string, number> {
  const counts = new Map<string, number>();
  if (model === null) return counts;
  for (const element of Object.values(model.elements)) {
    const sources = new Set(refsOf(element).map((ref) => ref.sourceId));
    for (const id of sources) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export function openDiscrepancies(model: BusinessModel | null): Discrepancy[] {
  if (model === null) return [];
  return Object.values(model.elements)
    .filter((e): e is Discrepancy => e.kind === 'discrepancy' && e.state === 'open')
    .sort(compareElements);
}

/** Nombre d'éléments par statut, pour le résumé d'un onglet. */
export function statusCounts(elements: Element[]): Record<ElementStatus, number> {
  const counts: Record<ElementStatus, number> = {
    extracted: 0,
    hypothesis: 0,
    confirmed: 0,
    validated: 0,
  };
  for (const element of elements) counts[element.status.value] += 1;
  return counts;
}

/** Libellé d'un élément référencé, à défaut son identifiant. */
export function labelOf(model: BusinessModel | null, id: string): string {
  const element = model?.elements[id];
  return element === undefined ? id : element.label;
}

// ---------------------------------------------------------------- exécutions

export interface ExtractionRunState {
  runId: string;
  status: RunStatus;
  progress: number;
  error: string | null;
  sourceId: string | null;
}

export const EXTRACTION_RUN_KIND = 'extraction';

export function isActive(run: { status: RunStatus } | null): boolean {
  return run !== null && (run.status === 'queued' || run.status === 'running');
}

/**
 * Intègre un message `run.progress` à l'état de l'extraction suivie. Les messages d'un autre
 * genre (dépôt de document) sont ignorés ; un message tardif ne ramène jamais une exécution
 * terminée à l'état actif.
 */
export function applyRunMessage(
  current: ExtractionRunState | null,
  message: RunProgressMessage,
): ExtractionRunState | null {
  if (message.kind !== EXTRACTION_RUN_KIND) return current;
  if (current?.runId === message.runId && !isActive(current) && isActive(message)) {
    return current;
  }
  return {
    runId: message.runId,
    status: message.status,
    progress: message.progress,
    error: message.error,
    sourceId: message.sourceId,
  };
}

/** Une source est analysable si son texte est lu et qu'elle contient des morceaux. */
export function isAnalyzable(source: SourceDto): boolean {
  return source.textStatus === 'extracted' && source.chunkCount > 0;
}

/** Sources dont le texte est encore en cours d'extraction : à interroger de nouveau. */
export function hasPendingSources(sources: SourceDto[]): boolean {
  return sources.some((source) => source.textStatus === 'pending');
}
