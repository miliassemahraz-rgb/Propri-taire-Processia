import {
  applyChangeSet,
  diffModels,
  type Activity,
  type BusinessModel,
  type ChangeSet,
  type Element,
  type ModelDiff,
} from '@processia/model';
import type { ProposalDto } from '@processia/contracts';

/** Modification par dialogue (WP-20) : aperçu d'une proposition, calculé dans le navigateur. */

/** Marqueur d'aperçu : ajout (vert), suppression (rouge), modification (orange). */
export type ChangeKind = 'added' | 'removed' | 'modified';

export interface ChangeEntry {
  id: string;
  change: ChangeKind;
  kind: Element['kind'];
  code: string;
  label: string;
  /** Pour un enchaînement : « A → B ». */
  route?: string;
  /** Champs modifiés (noms du modèle), pour une modification. */
  fields: string[];
}

export interface DialoguePreview {
  proposalId: string;
  before: BusinessModel;
  after: BusinessModel;
  diff: ModelDiff;
  /** Marqueurs sur le diagramme « avant » (retraits, modifications) et « après » (ajouts, modifications). */
  beforeChanges: Map<string, ChangeKind>;
  afterChanges: Map<string, ChangeKind>;
  entries: ChangeEntry[];
  /** Diagrammes qui contiennent un changement (`L2:<id>`, `L3:<id>`), du plus haut au plus bas. */
  diagrams: string[];
}

/** Champs qui ne se lisent pas comme un changement de contenu pour le consultant. */
const HIDDEN_FIELDS = new Set(['fieldProvenance', 'provenance', 'tags']);

const NODE_KINDS = new Set<Element['kind']>(['activity', 'event', 'gateway']);

/** Diagramme qui montre l'élément : le niveau 2 d'un processus, le niveau 3 d'une tâche. */
function diagramOf(model: BusinessModel, el: Element): string | null {
  const containerId =
    el.kind === 'activity'
      ? el.parentId
      : el.kind === 'event' || el.kind === 'gateway' || el.kind === 'sequence_flow'
        ? el.containerId
        : undefined;
  const container = containerId === undefined ? undefined : model.elements[containerId];
  if (container?.kind !== 'activity') return null;
  if (container.level === 'process') return `L2:${container.id}`;
  if (container.level === 'task') return `L3:${container.id}`;
  return null;
}

const labelOf = (model: BusinessModel, id: string): string => model.elements[id]?.label ?? id;

/**
 * Aperçu d'une proposition sur le modèle partagé : le ChangeSet est appliqué à une copie (fonction
 * pure du paquet modèle), rien n'est enregistré. `null` si la proposition n'est plus applicable
 * à cette version (elle est périmée ou en cours de recalcul).
 */
export function buildPreview(
  proposal: Pick<ProposalDto, 'id' | 'changeSet'>,
  model: BusinessModel,
): DialoguePreview | null {
  const changeSet = proposal.changeSet as ChangeSet | null;
  if (
    changeSet === null ||
    typeof changeSet !== 'object' ||
    changeSet.baseVersion !== model.version
  ) {
    return null;
  }
  const applied = applyChangeSet(model, changeSet, { actor: 'consultant' });
  if (!applied.ok) return null;
  const after = applied.model;
  const diff = diffModels(model, after);

  const beforeChanges = new Map<string, ChangeKind>();
  const afterChanges = new Map<string, ChangeKind>();
  const entries: ChangeEntry[] = [];
  const diagrams = new Set<string>();
  const route = (m: BusinessModel, el: Element): string | undefined =>
    el.kind === 'sequence_flow' ? `${labelOf(m, el.fromId)} → ${labelOf(m, el.toId)}` : undefined;
  const touch = (m: BusinessModel, el: Element): void => {
    const d = diagramOf(m, el);
    if (d !== null) diagrams.add(d);
  };

  for (const id of diff.added) {
    const el = after.elements[id];
    if (el === undefined) continue;
    entries.push({
      id,
      change: 'added',
      kind: el.kind,
      code: el.code,
      label: el.label,
      ...(route(after, el) === undefined ? {} : { route: route(after, el) as string }),
      fields: [],
    });
    if (NODE_KINDS.has(el.kind)) afterChanges.set(id, 'added');
    touch(after, el);
  }
  for (const id of diff.removed) {
    const el = model.elements[id];
    if (el === undefined) continue;
    entries.push({
      id,
      change: 'removed',
      kind: el.kind,
      code: el.code,
      label: el.label,
      ...(route(model, el) === undefined ? {} : { route: route(model, el) as string }),
      fields: [],
    });
    if (NODE_KINDS.has(el.kind)) beforeChanges.set(id, 'removed');
    touch(model, el);
  }
  for (const { id, fields } of diff.modified) {
    const before = model.elements[id];
    const el = after.elements[id];
    if (before === undefined || el === undefined) continue;
    const shown = fields.filter((f) => !HIDDEN_FIELDS.has(f));
    if (shown.length === 0) continue;
    entries.push({
      id,
      change: 'modified',
      kind: el.kind,
      code: el.code,
      label: el.label,
      ...(route(after, el) === undefined ? {} : { route: route(after, el) as string }),
      fields: shown,
    });
    if (NODE_KINDS.has(el.kind)) {
      beforeChanges.set(id, 'modified');
      afterChanges.set(id, 'modified');
    } else if (el.kind === 'sequence_flow') {
      // Un enchaînement modifié change la suite de son étape de départ.
      for (const [m, marks, ref] of [
        [model, beforeChanges, before],
        [after, afterChanges, el],
      ] as const) {
        if (ref.kind !== 'sequence_flow') continue;
        if (!marks.has(ref.fromId) && m.elements[ref.fromId] !== undefined) {
          marks.set(ref.fromId, 'modified');
        }
      }
    }
    touch(after, el);
  }
  // Un enchaînement ajouté ou retiré change aussi la suite d'une étape qui subsiste.
  for (const id of diff.added) {
    const el = after.elements[id];
    if (el?.kind === 'sequence_flow' && !afterChanges.has(el.fromId)) {
      afterChanges.set(el.fromId, 'modified');
    }
  }
  for (const id of diff.removed) {
    const el = model.elements[id];
    if (el?.kind === 'sequence_flow' && !beforeChanges.has(el.fromId)) {
      beforeChanges.set(el.fromId, 'modified');
    }
  }

  const order: Record<ChangeKind, number> = { added: 0, modified: 1, removed: 2 };
  entries.sort(
    (a, b) =>
      order[a.change] - order[b.change] ||
      Number(a.kind === 'sequence_flow') - Number(b.kind === 'sequence_flow') ||
      a.code.localeCompare(b.code, 'fr', { numeric: true }),
  );
  return {
    proposalId: proposal.id,
    before: model,
    after,
    diff,
    beforeChanges,
    afterChanges,
    entries,
    diagrams: [...diagrams].sort((a, b) => a.localeCompare(b)),
  };
}

/** Une proposition en attente que l'on peut prévisualiser sur la version affichée. */
export const isPreviewable = (proposal: ProposalDto, model: BusinessModel): boolean =>
  proposal.status === 'pending' && (proposal.changeSet as ChangeSet).baseVersion === model.version;

/** Niveau de la proposition à ouvrir : celui de la première modification, s'il diffère de l'affichage. */
export function diagramToOpen(preview: DialoguePreview, current: string): string | null {
  if (preview.diagrams.length === 0 || preview.diagrams.includes(current)) return null;
  return preview.diagrams[0] ?? null;
}

/** Activité qui contient l'élément (pour titrer le niveau concerné). */
export function activityOf(model: BusinessModel, diagram: string): Activity | undefined {
  const id = diagram.slice(3);
  const el = model.elements[id];
  return el?.kind === 'activity' ? el : undefined;
}
