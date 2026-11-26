import type { BusinessModel } from '../schema/business-model.js';
import type { ChangeSet, ModelOp } from '../schema/change-set.js';
import { collectRefs } from './refs.js';
import type { ModelDiff } from './types.js';

/**
 * Rejoue un ChangeSet sur la tête du modèle après des modifications intercalées (`intervening`,
 * un diff par version franchie). Réussit si les éléments touchés sont disjoints ; échoue sinon.
 *
 * Il y a conflit, pour un élément visé par une opération du ChangeSet, si :
 *  - il a été retiré entre-temps (toute opération qui le cible, ou qui le référence) ;
 *  - une opération `update` écrit un champ que les versions intercalées ont modifié ;
 *  - un `set_status` ou `reject_hypothesis` cible un élément dont le statut a changé entre-temps ;
 *  - un `remove` cible un élément modifié entre-temps.
 * Les dispositions (`set_layout`) ne sont jamais en conflit : le dernier écrit l'emporte.
 * Les cas non détectés ici (unicité de code, références nouvelles) sont rattrapés par
 * `applyChangeSet` à l'application.
 */
export function rebase(
  cs: ChangeSet,
  intervening: ModelDiff[],
  head: BusinessModel,
): { ok: true; cs: ChangeSet } | { ok: false; conflicts: string[] } {
  const removed = new Set<string>();
  const modifiedFields = new Map<string, Set<string>>();
  for (const d of intervening) {
    for (const id of d.removed) removed.add(id);
    for (const m of d.modified) {
      const set = modifiedFields.get(m.id) ?? new Set<string>();
      for (const f of m.fields) set.add(f);
      modifiedFields.set(m.id, set);
    }
  }
  const conflicts = new Set<string>();
  const check = (op: ModelOp): void => {
    switch (op.op) {
      case 'add':
        for (const r of collectRefs(op.element))
          if (removed.has(r.targetId)) conflicts.add(r.targetId);
        return;
      case 'update': {
        if (removed.has(op.id)) conflicts.add(op.id);
        const theirs = modifiedFields.get(op.id);
        if (theirs) {
          const mine = [...Object.keys(op.set), ...(op.unset ?? [])];
          if (mine.some((f) => theirs.has(f))) conflicts.add(op.id);
        }
        return;
      }
      case 'remove':
        for (const id of [op.id, ...(op.cascade ?? [])]) {
          if (removed.has(id) || modifiedFields.has(id)) conflicts.add(id);
        }
        return;
      case 'set_status':
      case 'reject_hypothesis':
        if (removed.has(op.id) || modifiedFields.get(op.id)?.has('status')) conflicts.add(op.id);
        return;
      case 'set_layout':
        return;
    }
  };
  for (const op of cs.ops) check(op);
  if (conflicts.size > 0) return { ok: false, conflicts: [...conflicts].sort() };
  return { ok: true, cs: { ...cs, ops: structuredClone(cs.ops), baseVersion: head.version } };
}
