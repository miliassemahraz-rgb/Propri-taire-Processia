import type { Activity } from '../schema/activity.js';
import type { BusinessModel } from '../schema/business-model.js';
import type { DiagramId } from '../schema/ids.js';
import type { Element } from '../schema/element.js';
import type { ElementStatus } from '../schema/provenance.js';
import type { Gateway } from '../schema/gateway.js';
import type { ProcessEvent } from '../schema/event.js';
import type { SequenceFlow } from '../schema/sequence-flow.js';

/**
 * Projection « structurée » d'un diagramme (spécification 6.3, WP-19) : les étapes dans l'ordre,
 * regroupées par acteur, avec leurs enchaînements. Elle sert la vue simplifiée et l'alternative
 * textuelle, qui lisent donc le même résultat, et elle est vérifiée contre le BPMN produit par
 * `@processia/bpmn` (mêmes éléments, voir le test de cohérence de ce paquet). Pur : même modèle,
 * même résultat.
 */

export type DiagramLevel = 'L0' | 'L1' | 'L2' | 'L3';

export interface ParsedDiagram {
  level: DiagramLevel;
  /** Identifiant de l'activité support (macroprocessus, processus ou tâche) ; absent au niveau 0. */
  anchorId?: string;
}

export function parseDiagramId(diagram: DiagramId): ParsedDiagram | undefined {
  if (diagram === 'L0') return { level: 'L0' };
  const m = /^(L[123]):(.+)$/.exec(diagram);
  if (!m) return undefined;
  return { level: m[1] as DiagramLevel, anchorId: m[2] as string };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byCodeId = <T extends { code: string; id: string }>(list: T[]): T[] =>
  [...list].sort((a, b) => compare(a.code, b.code) || compare(a.id, b.id));
const byOrder = (list: Activity[]): Activity[] =>
  [...list].sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      compare(a.code, b.code) ||
      compare(a.id, b.id),
  );

function activitiesOf(model: BusinessModel): Activity[] {
  return Object.values(model.elements).filter((e): e is Activity => e.kind === 'activity');
}

/**
 * Diagrammes d'un modèle (spécification 6.2) : `L0`, `L1:<macro>`, `L2:<processus>`, et `L3:<tâche>`
 * pour chaque tâche qui a des étapes. Ordre déterministe : niveau, puis code de l'activité.
 */
export function listDiagrams(model: BusinessModel): DiagramId[] {
  const acts = activitiesOf(model);
  const sorted = (level: Activity['level']): Activity[] =>
    byCodeId(acts.filter((a) => a.level === level));
  const hasSteps = new Set(acts.filter((a) => a.level === 'step').map((a) => a.parentId));
  return [
    'L0',
    ...sorted('macro').map((a) => `L1:${a.id}`),
    ...sorted('process').map((a) => `L2:${a.id}`),
    ...sorted('task')
      .filter((a) => hasSteps.has(a.id))
      .map((a) => `L3:${a.id}`),
  ];
}

/**
 * Chaîne des diagrammes de L0 jusqu'au diagramme demandé (fil d'Ariane L0 › L1 › L2 › L3), en
 * ne gardant que ceux qui existent. Vide si le diagramme est inconnu.
 */
export function diagramTrail(model: BusinessModel, diagram: DiagramId): DiagramId[] {
  const parsed = parseDiagramId(diagram);
  if (!parsed) return [];
  if (parsed.level === 'L0') return ['L0'];
  const known = new Set(listDiagrams(model));
  if (!known.has(diagram)) return [];
  const trail: DiagramId[] = [diagram];
  let current = model.elements[parsed.anchorId as string];
  while (current?.kind === 'activity' && current.parentId !== undefined) {
    const parent = model.elements[current.parentId];
    if (parent?.kind !== 'activity') break;
    const id =
      parent.level === 'macro'
        ? `L1:${parent.id}`
        : parent.level === 'process'
          ? `L2:${parent.id}`
          : `L3:${parent.id}`;
    if (known.has(id)) trail.unshift(id);
    current = parent;
  }
  trail.unshift('L0');
  return trail;
}

// ---------------------------------------------------------------------------------------------
// Plan structuré d'un diagramme
// ---------------------------------------------------------------------------------------------

export type OutlineNodeKind =
  | 'macro'
  | 'process'
  | 'task'
  | 'step'
  | 'start'
  | 'end'
  | 'intermediate'
  | 'boundary'
  | 'decision';

export interface OutlineNode {
  /** Identifiant de l'élément du modèle (le même que `processia:elementId` dans le BPMN). */
  id: string;
  kind: OutlineNodeKind;
  code: string;
  label: string;
  /** Rang dans l'ordre de lecture, à partir de 1. */
  number: number;
  /** Acteur du couloir (ou groupe) ; `null` : non affecté. */
  groupId: string | null;
  status: ElementStatus;
  /** Diagramme du niveau inférieur, s'il existe. */
  drillTo?: DiagramId;
  /** Passerelle : `exclusive` (décision), `parallel` ou `inclusive`. */
  gatewayType?: Gateway['type'];
  /** Événement : déclencheur (`timer`, `message`…) et délai. */
  trigger?: ProcessEvent['trigger'];
  timer?: string;
  /** Événement de bord : élément auquel il est rattaché. */
  attachedToId?: string;
  /** Activité : mode d'exécution. */
  execution?: Activity['execution'];
}

export interface OutlineEdge {
  /** Identifiant du flux ou du lien du modèle ; absent pour un enchaînement déduit de l'ordre. */
  id?: string;
  fromId: string;
  toId: string;
  /** Condition ou libellé de la branche. */
  label?: string;
  isDefault?: boolean;
  /** Enchaînement déduit de l'ordre (`processia:derived` dans le BPMN). */
  derived: boolean;
  /** Niveau 0 : nature du lien (`sequence`, `feeds`…). Les autres natures ne sont pas des flux. */
  nature?: 'sequence' | 'feeds' | 'steers' | 'supports';
}

export interface OutlineGroup {
  /** Identifiant de l'acteur, ou clé de catégorie au niveau 0 ; `null` : non affecté. */
  id: string | null;
  kind: 'actor' | 'category' | 'unassigned' | 'all';
  label: string;
  nodeIds: string[];
}

export interface DiagramOutline {
  diagram: DiagramId;
  level: DiagramLevel;
  anchorId?: string;
  /** Code et intitulé de l'élément support (vide au niveau 0). */
  anchorCode?: string;
  anchorLabel?: string;
  nodes: OutlineNode[];
  edges: OutlineEdge[];
  groups: OutlineGroup[];
}

const CATEGORY_ORDER = ['steering', 'core', 'support', 'none'] as const;

interface Draft {
  id: string;
  kind: OutlineNodeKind;
  el: Activity | ProcessEvent | Gateway;
}

function statusOf(el: Element): ElementStatus {
  return el.status.value;
}

/** Ordre de lecture : départs, puis parcours en largeur ; les nœuds isolés suivent. */
function readingOrder(canonical: string[], edges: OutlineEdge[], drafts: Map<string, Draft>) {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.nature !== undefined && e.nature !== 'sequence') continue;
    (out.get(e.fromId) ?? out.set(e.fromId, []).get(e.fromId)!).push(e.toId);
  }
  const boundaryOf = new Map<string, string[]>();
  for (const id of canonical) {
    const d = drafts.get(id) as Draft;
    if (d.el.kind === 'event' && d.el.position === 'boundary' && d.el.attachedToId !== undefined) {
      (
        boundaryOf.get(d.el.attachedToId) ??
        boundaryOf.set(d.el.attachedToId, []).get(d.el.attachedToId)!
      ).push(id);
    }
  }
  const hasIncoming = new Set(
    edges.filter((e) => e.nature === undefined || e.nature === 'sequence').map((e) => e.toId),
  );
  const starts = canonical.filter((id) => {
    const el = (drafts.get(id) as Draft).el;
    return el.kind === 'event' && el.position === 'start';
  });
  const roots = [
    ...starts,
    ...canonical.filter((id) => !hasIncoming.has(id) && !starts.includes(id)),
  ];
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [];
  const visit = (root: string): void => {
    queue.push(root);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id) || !drafts.has(id)) continue;
      seen.add(id);
      order.push(id);
      for (const b of boundaryOf.get(id) ?? []) queue.unshift(b);
      for (const next of out.get(id) ?? []) queue.push(next);
    }
  };
  for (const r of roots) visit(r);
  for (const id of canonical) visit(id);
  return order;
}

/**
 * Plan structuré d'un diagramme. Mêmes éléments que le BPMN de `@processia/bpmn` : au niveau 0, un
 * macroprocessus par `callActivity` ; au niveau 1, les processus du macroprocessus ; au niveau 2,
 * les tâches et sous-processus du processus, avec les événements et passerelles qu'il contient
 * (événements de bord compris quand leur hôte est présent) ; au niveau 3, les étapes de la tâche.
 */
export function buildOutline(model: BusinessModel, diagram: DiagramId): DiagramOutline | undefined {
  const parsed = parseDiagramId(diagram);
  if (!parsed) return undefined;
  const all = Object.values(model.elements);
  const acts = all.filter((e): e is Activity => e.kind === 'activity');
  const known = new Set(listDiagrams(model));
  const anchor = parsed.anchorId !== undefined ? model.elements[parsed.anchorId] : undefined;
  if (parsed.level !== 'L0') {
    const expected = parsed.level === 'L1' ? 'macro' : parsed.level === 'L2' ? 'process' : 'task';
    if (anchor?.kind !== 'activity' || anchor.level !== expected) return undefined;
  }

  const drafts = new Map<string, Draft>();
  const canonical: string[] = [];
  const edges: OutlineEdge[] = [];
  const container = anchor?.kind === 'activity' ? anchor : undefined;

  const activityKind = (a: Activity): OutlineNodeKind => a.level;
  const addActivities = (list: Activity[]): void => {
    for (const a of list) {
      drafts.set(a.id, { id: a.id, kind: activityKind(a), el: a });
      canonical.push(a.id);
    }
  };

  if (parsed.level === 'L0') {
    addActivities(byOrder(acts.filter((a) => a.level === 'macro')));
    const links = byCodeId(all.filter((e) => e.kind === 'process_link'));
    for (const l of links) {
      if (!drafts.has(l.fromId) || !drafts.has(l.toId)) continue;
      edges.push({
        id: l.id,
        fromId: l.fromId,
        toId: l.toId,
        ...(l.label !== '' && { label: l.label }),
        derived: false,
        nature: l.nature,
      });
    }
  } else {
    const containerId = (container as Activity).id;
    const levels: Activity['level'][] =
      parsed.level === 'L1' ? ['process'] : parsed.level === 'L2' ? ['task', 'process'] : ['step'];
    const children = byOrder(
      acts.filter((a) => a.parentId === containerId && levels.includes(a.level)),
    );
    addActivities(children);
    if (parsed.level !== 'L1') {
      const gateways = byCodeId(
        all.filter((e): e is Gateway => e.kind === 'gateway' && e.containerId === containerId),
      );
      for (const g of gateways) {
        drafts.set(g.id, { id: g.id, kind: 'decision', el: g });
        canonical.push(g.id);
      }
      const events = byCodeId(
        all.filter((e): e is ProcessEvent => e.kind === 'event' && e.containerId === containerId),
      );
      for (const ev of events) {
        if (
          ev.position === 'boundary' &&
          (ev.attachedToId === undefined || !drafts.has(ev.attachedToId))
        ) {
          continue;
        }
        drafts.set(ev.id, { id: ev.id, kind: ev.position, el: ev });
        canonical.push(ev.id);
      }
      const flows = byCodeId(
        all.filter(
          (e): e is SequenceFlow =>
            e.kind === 'sequence_flow' &&
            e.containerId === containerId &&
            drafts.has(e.fromId) &&
            drafts.has(e.toId),
        ),
      );
      for (const f of flows) {
        const from = drafts.get(f.fromId)?.el;
        const label = f.condition ?? (from?.kind === 'gateway' ? f.label : undefined);
        edges.push({
          id: f.id,
          fromId: f.fromId,
          toId: f.toId,
          ...(label !== undefined && label !== '' && { label }),
          ...(f.isDefault && { isDefault: true }),
          derived: false,
        });
      }
    }
    // Enchaînement déduit de l'ordre : niveaux 1 et 3 sans flux dans le modèle.
    const derive = parsed.level === 'L1' || (parsed.level === 'L3' && edges.length === 0);
    if (derive && edges.length === 0) {
      const chain = children.filter((a) => a.order !== undefined);
      for (let i = 0; i + 1 < chain.length; i++) {
        edges.push({
          fromId: (chain[i] as Activity).id,
          toId: (chain[i + 1] as Activity).id,
          derived: true,
        });
      }
    }
  }

  // --- Groupes : acteurs (niveaux 1 à 3) ou catégories (niveau 0) ---
  const actorOf = new Map<string, string | undefined>();
  const isActor = (id: string | undefined): id is string =>
    id !== undefined && model.elements[id]?.kind === 'actor';
  if (parsed.level !== 'L0') {
    for (const id of canonical) {
      const el = (drafts.get(id) as Draft).el;
      if (el.kind !== 'activity') continue;
      const candidates = [
        el.responsibleActorId,
        ...el.raci.filter((r) => r.role === 'R').map((r) => r.actorId),
        ...el.raci.filter((r) => r.role === 'A').map((r) => r.actorId),
      ];
      actorOf.set(id, candidates.find(isActor));
    }
    for (const id of canonical) {
      const el = (drafts.get(id) as Draft).el;
      if (el.kind === 'event') {
        actorOf.set(
          id,
          el.position === 'boundary'
            ? actorOf.get(el.attachedToId as string)
            : isActor(el.actorId)
              ? el.actorId
              : undefined,
        );
      } else if (el.kind === 'gateway') {
        actorOf.set(id, isActor(el.actorId) ? el.actorId : undefined);
      }
    }
    const pending = canonical.filter((id) => {
      const el = (drafts.get(id) as Draft).el;
      return el.kind === 'gateway' || (el.kind === 'event' && el.position !== 'boundary');
    });
    for (let pass = 0; pass < 6; pass++) {
      for (const id of pending) {
        if (actorOf.get(id) !== undefined) continue;
        const el = (drafts.get(id) as Draft).el;
        const isStart = el.kind === 'event' && el.position === 'start';
        const ins = edges.filter((e) => e.toId === id).map((e) => actorOf.get(e.fromId));
        const outs = edges.filter((e) => e.fromId === id).map((e) => actorOf.get(e.toId));
        const found = (isStart ? [...outs, ...ins] : [...ins, ...outs]).find(
          (x) => x !== undefined,
        );
        if (found !== undefined) actorOf.set(id, found);
      }
    }
  }

  const order = readingOrder(canonical, edges, drafts);
  const numberOf = new Map(order.map((id, i) => [id, i + 1]));
  const nodes: OutlineNode[] = order.map((id) => {
    const d = drafts.get(id) as Draft;
    const el = d.el;
    const node: OutlineNode = {
      id,
      kind: d.kind,
      code: el.code,
      label: el.label,
      number: numberOf.get(id) as number,
      groupId:
        parsed.level === 'L0'
          ? ((el as Activity).macroCategory ?? 'none')
          : (actorOf.get(id) ?? null),
      status: statusOf(el),
    };
    if (el.kind === 'activity') {
      node.execution = el.execution;
      const drill = diagramOfActivityKnown(el, known);
      if (drill !== undefined) node.drillTo = drill;
    } else if (el.kind === 'gateway') {
      node.gatewayType = el.type;
    } else {
      node.trigger = el.trigger;
      if (el.timer !== undefined) node.timer = el.timer;
      if (el.attachedToId !== undefined) node.attachedToId = el.attachedToId;
    }
    return node;
  });

  // --- Groupes ordonnés ---
  const groups: OutlineGroup[] = [];
  if (parsed.level === 'L0') {
    for (const cat of CATEGORY_ORDER) {
      const ids = nodes.filter((n) => n.groupId === cat).map((n) => n.id);
      if (ids.length > 0) {
        groups.push({
          id: cat,
          kind: cat === 'none' ? 'unassigned' : 'category',
          label: cat,
          nodeIds: ids,
        });
      }
    }
  } else {
    const actorIds = [
      ...new Set(nodes.map((n) => n.groupId).filter((x): x is string => x !== null)),
    ];
    const actors = byCodeId(
      actorIds
        .map((id) => model.elements[id])
        .filter((e): e is Extract<Element, { kind: 'actor' }> => e?.kind === 'actor'),
    );
    for (const a of actors) {
      groups.push({
        id: a.id,
        kind: 'actor',
        label: a.label,
        nodeIds: nodes.filter((n) => n.groupId === a.id).map((n) => n.id),
      });
    }
    const loose = nodes.filter((n) => n.groupId === null).map((n) => n.id);
    if (loose.length > 0) groups.push({ id: null, kind: 'unassigned', label: '', nodeIds: loose });
  }

  return {
    diagram,
    level: parsed.level,
    ...(container && {
      anchorId: container.id,
      anchorCode: container.code,
      anchorLabel: container.label,
    }),
    nodes,
    edges,
    groups,
  };
}

function diagramOfActivityKnown(a: Activity, known: Set<string>): DiagramId | undefined {
  if (a.level === 'step') return undefined;
  const id =
    a.level === 'macro' ? `L1:${a.id}` : a.level === 'process' ? `L2:${a.id}` : `L3:${a.id}`;
  return known.has(id) ? id : undefined;
}

/** Identifiants des éléments de nœud d'un diagramme : ce que le BPMN doit porter en `processia:elementId`. */
export const outlineNodeIds = (outline: DiagramOutline): string[] => outline.nodes.map((n) => n.id);

/**
 * Diagramme où l'élément se voit sur la carte (WP-21 : localisation d'un constat) : le macro-
 * processus au niveau 0, un processus au niveau 1, une tâche au niveau 2, une étape au niveau 3 ;
 * un événement, une passerelle ou un flux de séquence dans le diagramme de leur conteneur ; un flux
 * d'information dans celui de son activité. `undefined` : l'élément n'est dessiné nulle part
 * (acteur, règle, objet de données, constat…).
 */
export function diagramOfElement(model: BusinessModel, id: string): DiagramId | undefined {
  const el = model.elements[id];
  if (el === undefined) return undefined;
  const known = new Set(listDiagrams(model));
  const pick = (diagram: DiagramId): DiagramId | undefined =>
    known.has(diagram) ? diagram : undefined;
  switch (el.kind) {
    case 'activity':
      if (el.level === 'macro') return 'L0';
      if (el.parentId === undefined) return undefined;
      return pick(
        `${el.level === 'process' ? 'L1' : el.level === 'task' ? 'L2' : 'L3'}:${el.parentId}`,
      );
    case 'event':
    case 'gateway':
    case 'sequence_flow': {
      const container = model.elements[el.containerId];
      if (container?.kind !== 'activity') return undefined;
      return pick(`${container.level === 'process' ? 'L2' : 'L3'}:${container.id}`);
    }
    case 'information_flow':
      return el.activityId === undefined ? undefined : diagramOfElement(model, el.activityId);
    default:
      return undefined;
  }
}
