import type { OptimisationDecision } from '../schema/validation.js';
import { type DependencyNode, dependentsOf, findDependencyCycle } from './graph.js';

export type OptimisationState = 'undecided' | 'accepted' | 'accepted_with_reservation' | 'rejected';

export interface DecisionInput {
  optimisationId: string;
  value: 'accepted' | 'rejected';
  submissionId: string;
  by: string;
  at: string;
  comment?: string;
}

export interface DecisionOptions {
  /** Identifiant d'une nouvelle décision. Par défaut : `<soumission>:<optimisation>:<rang>`. */
  newId?: (optimisationId: string, rank: number) => string;
}

export type DecisionError =
  | { code: 'UNKNOWN_OPTIMISATION'; optimisationId: string }
  | { code: 'DEPENDENCY_CYCLE'; cycle: string[] }
  | { code: 'UNKNOWN_DEPENDENCY'; optimisationId: string; dependencyId: string }
  | { code: 'DEPENDENCY_REJECTED'; optimisationId: string; dependencyIds: string[] };

export type DecisionResult =
  | {
      ok: true;
      /** Historique complet : décisions précédentes (remplacées, `supersededAt` posé) et nouvelles. */
      decisions: OptimisationDecision[];
      created: OptimisationDecision[];
      /** Optimisations refusées en cascade par cette décision, dans l'ordre du graphe. */
      cascaded: string[];
    }
  | { ok: false; error: DecisionError };

/** Décision en vigueur de chaque optimisation (la plus récente non remplacée). */
export function activeDecisions(
  decisions: readonly OptimisationDecision[],
): Map<string, OptimisationDecision> {
  const out = new Map<string, OptimisationDecision>();
  for (const d of decisions) {
    if (d.supersededAt === undefined) out.set(d.optimisationId, d);
  }
  return out;
}

function validateGraph(graph: readonly DependencyNode[]): DecisionError | null {
  const ids = new Set(graph.map((n) => n.id));
  for (const n of graph) {
    for (const dep of n.dependsOn) {
      if (!ids.has(dep))
        return { code: 'UNKNOWN_DEPENDENCY', optimisationId: n.id, dependencyId: dep };
    }
  }
  const cycle = findDependencyCycle(graph);
  return cycle ? { code: 'DEPENDENCY_CYCLE', cycle } : null;
}

/**
 * Applique la décision du validateur sur une optimisation (spécification 2.7).
 *  - Refuser X refuse en cascade toutes les optimisations qui en dépendent, directement ou non
 *    (`cause: 'cascade'`, `cascadeFrom: X`) ; ce refus écrase une acceptation antérieure mais pas
 *    un refus déjà en vigueur.
 *  - Accepter ne rétablit rien : les refus en cascade venus de X restent [PO-7].
 *  - Accepter une optimisation dont une dépendance est refusée est refusé (`DEPENDENCY_REJECTED`) ;
 *    une dépendance non décidée est permise (« accepté sous réserve », voir `optimisationStates`).
 *  - Une décision remplace la précédente de la même optimisation (modifiable jusqu'à la clôture).
 * Le graphe doit être acyclique et fermé.
 */
export function applyDecision(
  graph: readonly DependencyNode[],
  decisions: readonly OptimisationDecision[],
  input: DecisionInput,
  options: DecisionOptions = {},
): DecisionResult {
  const invalid = validateGraph(graph);
  if (invalid) return { ok: false, error: invalid };
  const node = graph.find((n) => n.id === input.optimisationId);
  if (!node)
    return {
      ok: false,
      error: { code: 'UNKNOWN_OPTIMISATION', optimisationId: input.optimisationId },
    };

  const active = activeDecisions(decisions);
  if (input.value === 'accepted') {
    const rejectedDeps = node.dependsOn.filter((d) => active.get(d)?.value === 'rejected');
    if (rejectedDeps.length > 0) {
      return {
        ok: false,
        error: {
          code: 'DEPENDENCY_REJECTED',
          optimisationId: node.id,
          dependencyIds: rejectedDeps,
        },
      };
    }
  }

  const history = decisions.map((d) => ({ ...d }));
  const created: OptimisationDecision[] = [];
  const mint = (
    optimisationId: string,
    value: 'accepted' | 'rejected',
    cause: 'direct' | 'cascade',
  ): void => {
    const rank = history.filter((d) => d.optimisationId === optimisationId).length + 1;
    for (const d of history) {
      if (d.optimisationId === optimisationId && d.supersededAt === undefined)
        d.supersededAt = input.at;
    }
    const decision: OptimisationDecision = {
      id: options.newId
        ? options.newId(optimisationId, rank)
        : `${input.submissionId}:${optimisationId}:${rank}`,
      submissionId: input.submissionId,
      optimisationId,
      value,
      cause,
      ...(cause === 'cascade' ? { cascadeFrom: input.optimisationId } : {}),
      ...(cause === 'direct' && input.comment !== undefined ? { comment: input.comment } : {}),
      by: input.by,
      at: input.at,
    };
    history.push(decision);
    created.push(decision);
  };

  mint(node.id, input.value, 'direct');
  const cascaded: string[] = [];
  if (input.value === 'rejected') {
    for (const dep of dependentsOf(graph, node.id)) {
      if (active.get(dep)?.value === 'rejected') continue;
      mint(dep, 'rejected', 'cascade');
      cascaded.push(dep);
    }
  }
  return { ok: true, decisions: history, created, cascaded };
}

export interface CascadePreview {
  /** Optimisations qui seraient refusées en cascade, avec leur état actuel. */
  affected: { optimisationId: string; current: OptimisationState }[];
}

/** Aperçu de la cascade, à montrer avant confirmation d'un refus (spécification 2.7, règle 2). */
export function previewCascade(
  graph: readonly DependencyNode[],
  decisions: readonly OptimisationDecision[],
  optimisationId: string,
): { ok: true; preview: CascadePreview } | { ok: false; error: DecisionError } {
  const invalid = validateGraph(graph);
  if (invalid) return { ok: false, error: invalid };
  if (!graph.some((n) => n.id === optimisationId)) {
    return { ok: false, error: { code: 'UNKNOWN_OPTIMISATION', optimisationId } };
  }
  const states = optimisationStates(graph, decisions);
  const affected = dependentsOf(graph, optimisationId)
    .filter((id) => states[id] !== 'rejected')
    .map((id) => ({ optimisationId: id, current: states[id] as OptimisationState }));
  return { ok: true, preview: { affected } };
}

/**
 * État de chaque optimisation : `accepted_with_reservation` si elle est acceptée alors qu'une de ses
 * dépendances directes n'est pas acceptée (non décidée, ou acceptée sous réserve elle-même).
 */
export function optimisationStates(
  graph: readonly DependencyNode[],
  decisions: readonly OptimisationDecision[],
): Record<string, OptimisationState> {
  const active = activeDecisions(decisions);
  const out: Record<string, OptimisationState> = {};
  for (const n of graph) {
    const d = active.get(n.id);
    if (!d) out[n.id] = 'undecided';
    else if (d.value === 'rejected') out[n.id] = 'rejected';
    else {
      const reserved = n.dependsOn.some((dep) => active.get(dep)?.value !== 'accepted');
      out[n.id] = reserved ? 'accepted_with_reservation' : 'accepted';
    }
  }
  return out;
}

export type ClosureBlocker =
  | { code: 'UNDECIDED'; optimisationId: string }
  | { code: 'DEPENDENCY_NOT_ACCEPTED'; optimisationId: string; dependencyIds: string[] };

/**
 * La clôture exige que toutes les optimisations soient décidées [PO-27, valeur par défaut] et que
 * toutes les dépendances d'une optimisation acceptée soient acceptées.
 */
export function closureBlockers(
  graph: readonly DependencyNode[],
  decisions: readonly OptimisationDecision[],
): ClosureBlocker[] {
  const active = activeDecisions(decisions);
  const out: ClosureBlocker[] = [];
  for (const n of graph) {
    const d = active.get(n.id);
    if (!d) {
      out.push({ code: 'UNDECIDED', optimisationId: n.id });
      continue;
    }
    if (d.value === 'accepted') {
      const bad = n.dependsOn.filter((dep) => active.get(dep)?.value !== 'accepted');
      if (bad.length > 0)
        out.push({ code: 'DEPENDENCY_NOT_ACCEPTED', optimisationId: n.id, dependencyIds: bad });
    }
  }
  return out;
}
