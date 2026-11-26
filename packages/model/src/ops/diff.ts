import type { BusinessModel } from '../schema/business-model.js';
import type { ModelDiff } from './types.js';

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => deepEqual(ao[k], bo[k]));
}

/** Différence entre deux modèles : éléments ajoutés, retirés, modifiés (par champ) et dispositions. */
export function diffModels(a: BusinessModel, b: BusinessModel): ModelDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: { id: string; fields: string[] }[] = [];
  for (const id of Object.keys(b.elements)) {
    if (!(id in a.elements)) added.push(id);
  }
  for (const [id, before] of Object.entries(a.elements)) {
    const after = b.elements[id];
    if (!after) {
      removed.push(id);
      continue;
    }
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const fields = [...keys]
      .filter((k) => k !== 'meta')
      .filter(
        (k) =>
          !deepEqual(
            (before as unknown as Record<string, unknown>)[k],
            (after as unknown as Record<string, unknown>)[k],
          ),
      )
      .sort();
    if (fields.length > 0) modified.push({ id, fields });
  }
  const diagrams = new Set([...Object.keys(a.layout), ...Object.keys(b.layout)]);
  const layout = [...diagrams].filter((d) => !deepEqual(a.layout[d], b.layout[d])).sort();
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort(byId), layout };
}

function byId(x: { id: string }, y: { id: string }): number {
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}
