import type { ModelOp } from '../schema/change-set.js';
import type { Optimisation } from '../schema/optimisation.js';

/** Nœud du graphe de dépendances entre optimisations. */
export interface DependencyNode {
  id: string;
  code?: string;
  dependsOn: readonly string[];
}

function compareNodes(a: DependencyNode, b: DependencyNode): number {
  const ca = a.code ?? '';
  const cb = b.code ?? '';
  const byCode = ca.localeCompare(cb, 'en', { numeric: true });
  return byCode !== 0 ? byCode : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Cherche un cycle ; renvoie ses identifiants dans l'ordre (le premier est répété à la fin). */
export function findDependencyCycle(nodes: readonly DependencyNode[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === 'done') return null;
    if (s === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const c = visit(dep);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const n of [...nodes].sort(compareNodes)) {
    const c = visit(n.id);
    if (c) return c;
  }
  return null;
}

/**
 * Ordre topologique : un nœud vient après ses dépendances ; à égalité, par code puis identifiant.
 * Les dépendances hors de la liste sont ignorées.
 */
export function topologicalOrder(
  nodes: readonly DependencyNode[],
): { ok: true; order: string[] } | { ok: false; cycle: string[] } {
  const cycle = findDependencyCycle(nodes);
  if (cycle) return { ok: false, cycle };
  const ids = new Set(nodes.map((n) => n.id));
  const remaining = new Map(
    nodes.map((n) => [n.id, new Set(n.dependsOn.filter((d) => ids.has(d)))]),
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => byId.get(id) as DependencyNode)
      .sort(compareNodes);
    const first = ready[0] as DependencyNode;
    order.push(first.id);
    remaining.delete(first.id);
    for (const deps of remaining.values()) deps.delete(first.id);
  }
  return { ok: true, order };
}

/** Optimisations qui dépendent de `id`, directement ou non (jamais `id` lui-même). */
export function dependentsOf(nodes: readonly DependencyNode[], id: string): string[] {
  const out = new Set<string>();
  const frontier = [id];
  while (frontier.length > 0) {
    const cur = frontier.pop() as string;
    for (const n of nodes) {
      if (n.dependsOn.includes(cur) && !out.has(n.id) && n.id !== id) {
        out.add(n.id);
        frontier.push(n.id);
      }
    }
  }
  return nodes.map((n) => n.id).filter((x) => out.has(x));
}

/** Dépendances de `id`, directes ou non. */
export function dependenciesOf(nodes: readonly DependencyNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const frontier = [id];
  while (frontier.length > 0) {
    const cur = frontier.pop() as string;
    for (const dep of byId.get(cur)?.dependsOn ?? []) {
      if (!out.has(dep) && dep !== id) {
        out.add(dep);
        frontier.push(dep);
      }
    }
  }
  return [...out];
}

/** Éléments visés par les opérations d'un ChangeSet (hors ajouts). */
export function opTargets(ops: readonly ModelOp[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op.op === 'update' || op.op === 'set_status' || op.op === 'reject_hypothesis')
      out.push(op.id);
    else if (op.op === 'remove') out.push(op.id, ...(op.cascade ?? []));
  }
  return out;
}

/** Éléments touchés par une optimisation : `touchedElementIds` et cibles de son ChangeSet. */
export function touchedIds(o: Pick<Optimisation, 'touchedElementIds' | 'changeSet'>): Set<string> {
  return new Set([...o.touchedElementIds, ...opTargets(o.changeSet.ops)]);
}

export interface OptimisationConflict {
  a: string;
  b: string;
  elementIds: string[];
}

/**
 * Conflits entre optimisations (spécification 2.7, règle 7) : mêmes éléments touchés sans
 * dépendance déclarée (directe ou non) dans l'un ou l'autre sens. Deux alternatives l'une de
 * l'autre (`alternativeOf`) s'excluent par construction : pas de conflit. Détecté à la
 * soumission ; bloque celle-ci tant que le consultant n'a pas résolu.
 */
export function detectOptimisationConflicts(
  optimisations: readonly Optimisation[],
): OptimisationConflict[] {
  const nodes: DependencyNode[] = optimisations.map((o) => ({
    id: o.id,
    code: o.code,
    dependsOn: o.dependsOn,
  }));
  const touched = new Map(optimisations.map((o) => [o.id, touchedIds(o)]));
  const sorted = [...optimisations].sort((x, y) =>
    compareNodes(
      nodes.find((n) => n.id === x.id) as DependencyNode,
      nodes.find((n) => n.id === y.id) as DependencyNode,
    ),
  );
  const out: OptimisationConflict[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i] as Optimisation;
      const b = sorted[j] as Optimisation;
      if (a.alternativeOf === b.id || b.alternativeOf === a.id) continue;
      const shared = [...(touched.get(a.id) as Set<string>)].filter((id) =>
        (touched.get(b.id) as Set<string>).has(id),
      );
      if (shared.length === 0) continue;
      if (dependenciesOf(nodes, a.id).includes(b.id) || dependenciesOf(nodes, b.id).includes(a.id))
        continue;
      out.push({ a: a.id, b: b.id, elementIds: shared.sort() });
    }
  }
  return out;
}
