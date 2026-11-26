import type { BusinessModel } from '../schema/business-model.js';
import type { ChangeSet } from '../schema/change-set.js';
import type { Element } from '../schema/element.js';
import { elementsOfKind } from './coherence.js';
import { scrubRefs } from './refs.js';
import type { RaciMatrix, RaciRole } from './types.js';

const ROLE_ORDER: RaciRole[] = ['R', 'A', 'C', 'I'];

/**
 * Vue destinée aux livrables (CDC 3.4) [PO-11] : sans hypothèse (élément, champ de donnée,
 * archive des hypothèses rejetées, ajout proposé par une optimisation) et sans écart ouvert.
 * Les éléments « Extrait » non confirmés restent (leur source est affichée par l'export).
 * Les références vers les éléments retirés sont nettoyées ; un élément qui ne peut pas survivre
 * à la perte d'une référence obligatoire est retiré à son tour (jusqu'à stabilité).
 */
export function deliverableView(model: BusinessModel): BusinessModel {
  const removed = new Set<string>();
  const elements: Record<string, Element> = {};
  for (const [id, el] of Object.entries(model.elements)) {
    if (el.status.value === 'hypothesis' || (el.kind === 'discrepancy' && el.state === 'open')) {
      removed.add(id);
    } else {
      elements[id] = el;
    }
  }
  // Champs de données hypothétiques.
  const fieldIds = new Set<string>();
  for (const [id, el] of Object.entries(elements)) {
    if (el.kind !== 'data_object') continue;
    const kept = el.fields.filter((f) => f.status.value !== 'hypothesis');
    if (kept.length !== el.fields.length) {
      for (const f of el.fields) if (f.status.value === 'hypothesis') fieldIds.add(f.id);
      elements[id] = { ...el, fields: kept };
    }
  }
  const gone = new Set<string>([...removed, ...fieldIds]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, el] of Object.entries(elements)) {
      const scrubbed = scrubRefs(el, gone);
      if (scrubbed === null) {
        delete elements[id];
        gone.add(id);
        changed = true;
      } else {
        elements[id] = scrubbed;
      }
    }
  }
  const layout: BusinessModel['layout'] = {};
  for (const [diagram, boxes] of Object.entries(model.layout)) {
    layout[diagram] = Object.fromEntries(Object.entries(boxes).filter(([id]) => !gone.has(id)));
  }
  for (const [id, el] of Object.entries(elements)) {
    if (el.kind === 'optimisation') {
      elements[id] = { ...el, changeSet: stripHypothesisAdds(el.changeSet) };
    }
  }
  return { ...model, elements, rejectedHypotheses: [], layout };
}

function stripHypothesisAdds(cs: ChangeSet): ChangeSet {
  return {
    ...cs,
    ops: cs.ops.filter((op) => !(op.op === 'add' && op.element.status.value === 'hypothesis')),
  };
}

/**
 * Matrice RACI. `scopeId` : une activité ; la matrice porte alors ses descendantes (ou elle-même
 * si elle n'en a pas). Sans portée : toutes les activités. `responsibleActorId` compte pour `R`.
 * Lignes ordonnées par code, colonnes (acteurs présents) par code.
 */
export function raciMatrix(model: BusinessModel, scopeId?: string): RaciMatrix {
  const acts = elementsOfKind(model, 'activity');
  let selected = acts;
  if (scopeId !== undefined) {
    const descendants = new Set<string>();
    let frontier = [scopeId];
    while (frontier.length > 0) {
      const next = acts.filter((a) => a.parentId !== undefined && frontier.includes(a.parentId));
      frontier = next.map((a) => a.id).filter((id) => !descendants.has(id));
      for (const id of frontier) descendants.add(id);
    }
    selected =
      descendants.size > 0
        ? acts.filter((a) => descendants.has(a.id))
        : acts.filter((a) => a.id === scopeId);
  }
  const used = new Set<string>();
  const rows = [...selected]
    .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
    .map((a) => {
      const roles: Record<string, RaciRole[]> = {};
      const put = (actorId: string, role: RaciRole): void => {
        const list = roles[actorId] ?? (roles[actorId] = []);
        if (!list.includes(role)) list.push(role);
      };
      for (const r of a.raci) put(r.actorId, r.role);
      if (a.responsibleActorId) put(a.responsibleActorId, 'R');
      for (const k of Object.keys(roles)) {
        (roles[k] as RaciRole[]).sort((x, y) => ROLE_ORDER.indexOf(x) - ROLE_ORDER.indexOf(y));
        used.add(k);
      }
      return { activityId: a.id, code: a.code, label: a.label, level: a.level, roles };
    });
  const actors = [...used]
    .map((id) => model.elements[id])
    .filter((e): e is Extract<Element, { kind: 'actor' }> => e?.kind === 'actor')
    .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
    .map((a) => ({ id: a.id, code: a.code, label: a.label }));
  return { actors, rows };
}
