import type { BusinessModel } from '../schema/business-model.js';
import type { Element } from '../schema/element.js';
import { collectRefs, scrubRefs } from './refs.js';

export interface RejectionUpdate {
  id: string;
  /** Propriétés dont la valeur change (références retirées). */
  set: Record<string, unknown>;
  /** Propriétés retirées (référence facultative vers un élément rejeté). */
  unset: string[];
}

export type RejectionPlan =
  | {
      ok: true;
      /** Hypothèses à rejeter : les racines et, de proche en proche, celles qui ne survivent pas. */
      reject: string[];
      /** Hypothèses conservées dont une référence vers un élément rejeté est retirée. */
      updates: RejectionUpdate[];
    }
  | {
      ok: false;
      /** Éléments décidés (non hypothétiques) qui référencent un élément à rejeter. */
      blockedBy: { id: string; code: string; label: string }[];
    };

type Obj = Record<string, unknown>;

/**
 * Plan de rejet d'hypothèses (spécification 2.1) : rejeter un élément retire aussi les
 * hypothèses qui ne peuvent pas survivre à sa disparition (référence obligatoire) et nettoie les
 * références facultatives des autres hypothèses. Un élément déjà décidé (extrait, confirmé ou
 * validé) n'est jamais modifié : s'il référence un élément à rejeter, le rejet est refusé.
 * Fonction pure : l'application se fait par un ChangeSet (`reject_hypothesis`, `update`).
 */
export function planHypothesisRejection(
  model: BusinessModel,
  rootIds: readonly string[],
): RejectionPlan {
  const removed = new Set(rootIds);
  const refsTo = (e: Element): boolean => collectRefs(e).some((r) => removed.has(r.targetId));
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of Object.values(model.elements)) {
      if (removed.has(e.id) || !refsTo(e)) continue;
      if (scrubRefs(e, removed) !== null) continue;
      if (e.status.value === 'hypothesis') {
        removed.add(e.id);
        changed = true;
      } else {
        blocked.add(e.id);
      }
    }
  }
  const updates: RejectionUpdate[] = [];
  for (const e of Object.values(model.elements)) {
    if (removed.has(e.id) || blocked.has(e.id) || !refsTo(e)) continue;
    if (e.status.value !== 'hypothesis') {
      blocked.add(e.id);
      continue;
    }
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
    updates.push({ id: e.id, set, unset });
  }
  if (blocked.size > 0) {
    return {
      ok: false,
      blockedBy: [...blocked].map((id) => {
        const e = model.elements[id] as Element;
        return { id, code: e.code, label: e.label };
      }),
    };
  }
  return { ok: true, reject: [...removed], updates };
}
