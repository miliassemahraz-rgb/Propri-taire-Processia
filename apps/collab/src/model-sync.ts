import { MODEL_ELEMENTS_MAP, MODEL_META_MAP } from '@processia/contracts';
import type { BusinessModel, ModelDiff } from '@processia/model';
import type * as Y from 'yjs';

/** Métadonnées de la version reflétée (hors modèle), écrites dans la `Y.Map` `meta`. */
export interface VersionMeta {
  authorId: string | null;
  at: string | null;
}

/** Égalité structurelle de valeurs JSON (l'ordre des clés d'un objet est sans effet). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => jsonEqual(value, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && jsonEqual(left[key], right[key]));
}

export interface ReconcileResult {
  changed: boolean;
  added: number;
  removed: number;
  updated: number;
}

/**
 * Aligne le document `model` sur la version `model` (tête de la mission) en n'écrivant que la
 * **différence minimale** : éléments ajoutés, modifiés ou retirés (spécification 5.3).
 *
 * Chemin rapide : si `diff` est fourni et que le document reflète la version précédente, seuls les
 * éléments qu'il cite sont comparés. Sinon (document vide, en retard de plusieurs versions,
 * notification manquée), tout le contenu est comparé : le résultat est le même, le document n'est
 * qu'un cache reconstructible depuis `model_versions`.
 */
export function reconcileModelDoc(
  doc: Y.Doc,
  model: BusinessModel | null,
  meta: VersionMeta,
  diff?: ModelDiff | null,
): ReconcileResult {
  const elements = doc.getMap<unknown>(MODEL_ELEMENTS_MAP);
  const metaMap = doc.getMap<unknown>(MODEL_META_MAP);
  const result: ReconcileResult = { changed: false, added: 0, removed: 0, updated: 0 };
  const target = model?.elements ?? {};
  const currentVersion = metaMap.get('version');

  const incremental =
    diff !== undefined &&
    diff !== null &&
    model !== null &&
    typeof currentVersion === 'number' &&
    currentVersion === model.version - 1;
  const ids = incremental
    ? new Set([...diff.added, ...diff.removed, ...diff.modified.map((m) => m.id)])
    : new Set([...elements.keys(), ...Object.keys(target)]);

  doc.transact(() => {
    for (const id of ids) {
      const wanted = target[id];
      if (wanted === undefined) {
        if (elements.has(id)) {
          elements.delete(id);
          result.removed += 1;
        }
      } else if (!elements.has(id)) {
        elements.set(id, wanted);
        result.added += 1;
      } else if (!jsonEqual(elements.get(id), wanted)) {
        elements.set(id, wanted);
        result.updated += 1;
      }
    }
    const setIfChanged = (key: string, value: unknown): void => {
      if (!jsonEqual(metaMap.get(key), value)) {
        metaMap.set(key, value);
        result.changed = true;
      }
    };
    setIfChanged('schemaVersion', model?.schemaVersion ?? null);
    setIfChanged('missionId', model?.missionId ?? null);
    setIfChanged('version', model?.version ?? 0);
    setIfChanged('authorId', meta.authorId);
    setIfChanged('at', meta.at);
    setIfChanged('rejectedHypotheses', model?.rejectedHypotheses ?? []);
    setIfChanged('layout', model?.layout ?? {});
  });
  result.changed = result.changed || result.added + result.removed + result.updated > 0;
  return result;
}
