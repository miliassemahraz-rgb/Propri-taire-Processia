import type { BusinessModel } from '../schema/business-model.js';
import type { Element } from '../schema/element.js';
import type { ElementKind } from '../schema/kinds.js';

/**
 * Références entre éléments, par type. Sert à l'intégrité référentielle, à la suppression
 * et à la vue livrable.
 *  - req : référence obligatoire (l'élément ne survit pas à sa cible) ;
 *  - opt : référence facultative (retirée si la cible disparaît) ;
 *  - ids : liste d'identifiants (filtrée) ; ids_min1 : liste non vide obligatoire ;
 *  - item : chaque entrée du tableau porte la référence ; l'entrée est retirée avec sa cible.
 * Un chemin `a[].b` désigne la propriété `b` de chaque entrée du tableau `a`.
 */
export type RefMode = 'req' | 'opt' | 'ids' | 'ids_min1' | 'item';
export interface RefSpec {
  path: string;
  mode: RefMode;
}

export const REF_SPECS: Record<ElementKind, RefSpec[]> = {
  business_trait: [],
  glossary_term: [],
  actor: [{ path: 'parentId', mode: 'opt' }],
  activity: [
    { path: 'parentId', mode: 'req' },
    { path: 'responsibleActorId', mode: 'opt' },
    { path: 'raci[].actorId', mode: 'item' },
    { path: 'inputs', mode: 'ids' },
    { path: 'outputs', mode: 'ids' },
    { path: 'toolIds', mode: 'ids' },
    { path: 'ruleIds', mode: 'ids' },
  ],
  event: [
    { path: 'containerId', mode: 'req' },
    { path: 'attachedToId', mode: 'req' },
    { path: 'actorId', mode: 'opt' },
  ],
  gateway: [
    { path: 'containerId', mode: 'req' },
    { path: 'ruleId', mode: 'opt' },
    { path: 'actorId', mode: 'opt' },
  ],
  sequence_flow: [
    { path: 'containerId', mode: 'req' },
    { path: 'fromId', mode: 'req' },
    { path: 'toId', mode: 'req' },
    { path: 'ruleId', mode: 'opt' },
  ],
  process_link: [
    { path: 'fromId', mode: 'req' },
    { path: 'toId', mode: 'req' },
    { path: 'dataObjectIds', mode: 'ids' },
  ],
  data_object: [
    { path: 'toolIds', mode: 'ids' },
    { path: 'fields[].referenceObjectId', mode: 'opt' },
  ],
  tool: [{ path: 'systemActorId', mode: 'opt' }],
  information_flow: [
    { path: 'fromActorId', mode: 'req' },
    { path: 'toActorId', mode: 'req' },
    { path: 'dataObjectIds', mode: 'ids' },
    { path: 'activityId', mode: 'opt' },
  ],
  rule: [
    { path: 'appliesTo', mode: 'ids' },
    { path: 'dependsOn', mode: 'ids' },
    { path: 'exceptionHandling.activityIds', mode: 'ids' },
  ],
  indicator: [{ path: 'targetId', mode: 'req' }],
  discrepancy: [{ path: 'elementIds', mode: 'ids' }],
  finding: [{ path: 'location', mode: 'ids_min1' }],
  optimisation: [
    { path: 'findingIds', mode: 'ids_min1' },
    { path: 'alternativeOf', mode: 'opt' },
    { path: 'touchedElementIds', mode: 'ids' },
    { path: 'dependsOn', mode: 'ids' },
  ],
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parcourt un chemin ; `visit(holder, key)` est appelé pour chaque propriété finale. */
function walk(root: Obj, path: string, visit: (holder: Obj, key: string) => void): void {
  const parts = path.split('.');
  const go = (node: unknown, i: number): void => {
    if (!isObj(node)) return;
    const part = parts[i] as string;
    const isLast = i === parts.length - 1;
    if (part.endsWith('[]')) {
      const arr = node[part.slice(0, -2)];
      if (!Array.isArray(arr) || isLast) return;
      for (const item of arr) go(item, i + 1);
      return;
    }
    if (isLast) visit(node, part);
    else go(node[part], i + 1);
  };
  go(root, 0);
}

export interface RefOccurrence {
  path: string;
  targetId: string;
}

/** Toutes les références sortantes d'un élément. */
export function collectRefs(element: Element): RefOccurrence[] {
  const out: RefOccurrence[] = [];
  for (const spec of REF_SPECS[element.kind]) {
    if (spec.mode === 'item') {
      const [arrPart, prop] = spec.path.split('[].') as [string, string];
      const arr = (element as unknown as Obj)[arrPart];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (isObj(item) && typeof item[prop] === 'string') {
            out.push({ path: spec.path, targetId: item[prop] });
          }
        }
      }
      continue;
    }
    walk(element as unknown as Obj, spec.path, (holder, key) => {
      const v = holder[key];
      if (typeof v === 'string') out.push({ path: spec.path, targetId: v });
      else if (Array.isArray(v)) {
        for (const x of v) if (typeof x === 'string') out.push({ path: spec.path, targetId: x });
      }
    });
  }
  return out;
}

/** Identifiants connus : éléments et champs de données (cibles valides de certaines références). */
export function knownIds(model: BusinessModel): Set<string> {
  const ids = new Set<string>(Object.keys(model.elements));
  for (const el of Object.values(model.elements)) {
    if (el.kind === 'data_object') for (const f of el.fields) ids.add(f.id);
  }
  return ids;
}

export interface DanglingReference {
  elementId: string;
  path: string;
  targetId: string;
}

/** Références vers un identifiant absent du modèle. */
export function danglingReferences(model: BusinessModel): DanglingReference[] {
  const known = knownIds(model);
  const out: DanglingReference[] = [];
  for (const el of Object.values(model.elements)) {
    for (const r of collectRefs(el)) {
      if (!known.has(r.targetId))
        out.push({ elementId: el.id, path: r.path, targetId: r.targetId });
    }
  }
  return out;
}

/**
 * Retire de l'élément toute référence vers `removed`. Renvoie `null` si l'élément ne peut pas
 * survivre (référence obligatoire perdue, liste obligatoire vidée).
 */
export function scrubRefs(element: Element, removed: ReadonlySet<string>): Element | null {
  const copy = structuredClone(element) as unknown as Obj;
  let drop = false;
  for (const spec of REF_SPECS[element.kind]) {
    if (spec.mode === 'item') {
      const [arrPart, prop] = spec.path.split('[].') as [string, string];
      const arr = copy[arrPart];
      if (Array.isArray(arr)) {
        copy[arrPart] = arr.filter((it) => !(isObj(it) && removed.has(String(it[prop]))));
      }
      continue;
    }
    walk(copy, spec.path, (holder, key) => {
      const v = holder[key];
      if (typeof v === 'string' && removed.has(v)) {
        if (spec.mode === 'req') drop = true;
        else delete holder[key];
      } else if (Array.isArray(v)) {
        const kept = v.filter((x) => !(typeof x === 'string' && removed.has(x)));
        if (kept.length !== v.length) {
          holder[key] = kept;
          if (spec.mode === 'ids_min1' && kept.length === 0) drop = true;
        }
      }
    });
  }
  return drop ? null : (copy as unknown as Element);
}
