import type { BusinessModel } from '../schema/business-model.js';
import type { ModelOp } from '../schema/change-set.js';
import type { Element } from '../schema/element.js';
import { collectRefs, scrubRefs } from './refs.js';

export interface RemovalPlan {
  /** Éléments retirés : les racines et tout ce qui ne survit pas à leur disparition. */
  removed: string[];
  /** Opérations à écrire dans un ChangeSet : `update` des survivants, retrait des éléments. */
  ops: ModelOp[];
}

type Obj = Record<string, unknown>;

/**
 * Plan de retrait d'éléments décidé par le consultant (dialogue, WP-20). Contrairement au rejet
 * d'hypothèses (`planHypothesisRejection`), il vaut pour tout statut : ce qui ne peut pas
 * survivre à la disparition d'une racine part avec elle (niveau 3 d'une tâche, flux de séquence,
 * événements de bord, indicateurs…) et les références facultatives des survivants sont retirées.
 * Une hypothèse retirée l'est par `reject_hypothesis` (elle rejoint la liste des hypothèses
 * rejetées, que l'IA ne reproposera pas) ; les autres par `remove`.
 * Fonction pure ; l'intégrité finale est vérifiée par `applyChangeSet`.
 */
export function planRemoval(
  model: BusinessModel,
  rootIds: readonly string[],
  options: { reason?: string } = {},
): RemovalPlan {
  const removed = new Set(rootIds.filter((id) => id in model.elements));
  const refsTo = (e: Element): boolean => collectRefs(e).some((r) => removed.has(r.targetId));
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of Object.values(model.elements)) {
      if (removed.has(e.id) || !refsTo(e)) continue;
      if (scrubRefs(e, removed) === null) {
        removed.add(e.id);
        changed = true;
      }
    }
  }
  const ops: ModelOp[] = [];
  for (const e of Object.values(model.elements)) {
    if (removed.has(e.id) || !refsTo(e)) continue;
    const scrubbed = scrubRefs(e, removed) as Element;
    const before = e as unknown as Obj;
    const after = scrubbed as unknown as Obj;
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      if (after[key] === undefined) unset.push(key);
      else set[key] = after[key];
    }
    ops.push({ op: 'update', id: e.id, set, ...(unset.length === 0 ? {} : { unset }) });
  }
  for (const id of [...removed].sort()) {
    const e = model.elements[id] as Element;
    ops.push(
      e.status.value === 'hypothesis'
        ? {
            op: 'reject_hypothesis',
            id,
            ...(options.reason === undefined ? {} : { reason: options.reason }),
          }
        : { op: 'remove', id },
    );
  }
  return { removed: [...removed].sort(), ops };
}
