import type {
  Activity,
  BusinessModel,
  DiagramOutline,
  Element,
  ElementStatus,
  OutlineNode,
  SourceRef,
} from '@processia/model';

/** Visionneuse de cartographie (WP-19) : fonctions pures de la vue simplifiée, de l'alternative
 * textuelle et du panneau de l'élément sélectionné. */

// ---------------------------------------------------------------------------------------------
// Géométrie de la vue simplifiée
// ---------------------------------------------------------------------------------------------

export const CARD_W = 176;
export const CARD_H = 92;
export const GAP_X = 36;
export const GAP_Y = 14;
export const LANE_LABEL_W = 168;
export const LANE_PAD = 10;
export const LANE_GAP = 10;

export interface SimplePlacement {
  col: number;
  /** Rang de la carte dans son couloir. */
  slot: number;
  x: number;
  y: number;
}

export interface SimpleLane {
  groupId: string | null;
  top: number;
  height: number;
  nodeIds: string[];
}

export interface SimpleArrow {
  key: string;
  fromId: string;
  toId: string;
  label?: string;
  derived: boolean;
  /** Courbe SVG de la flèche (de la carte source à la carte cible). */
  path: string;
  /** Position du libellé (condition de la branche). */
  labelAt: { x: number; y: number };
}

export interface SimpleLayout {
  width: number;
  height: number;
  columns: number;
  lanes: SimpleLane[];
  placements: Record<string, SimplePlacement>;
  arrows: SimpleArrow[];
}

/**
 * Disposition de la vue simplifiée : une ligne par couloir (acteur ou catégorie), une colonne par
 * « profondeur » dans l'enchaînement (le plus long chemin depuis un départ, retours exclus). Des
 * cartes de même couloir et de même colonne se placent l'une sous l'autre. Les coordonnées sont
 * calculées, pas mesurées : les flèches SVG se superposent exactement aux cartes.
 */
export function layoutSimple(outline: DiagramOutline): SimpleLayout {
  const byId = new Map(outline.nodes.map((n) => [n.id, n]));
  const flows = outline.edges.filter((e) => e.nature === undefined || e.nature === 'sequence');
  const depth = new Map<string, number>();
  for (const node of outline.nodes) {
    // Les nœuds sont triés par rang : un lien vers un rang plus petit est un retour, ignoré.
    let d = 0;
    for (const e of flows) {
      if (e.toId !== node.id) continue;
      const from = byId.get(e.fromId);
      if (from !== undefined && from.number < node.number) {
        d = Math.max(d, (depth.get(from.id) ?? 0) + 1);
      }
    }
    if (node.kind === 'boundary' && node.attachedToId !== undefined && d === 0) {
      d = depth.get(node.attachedToId) ?? 0;
    }
    depth.set(node.id, d);
  }
  const columns = Math.max(1, ...[...depth.values()].map((d) => d + 1));

  const placements: Record<string, SimplePlacement> = {};
  const lanes: SimpleLane[] = [];
  let top = 0;
  for (const group of outline.groups) {
    const used = new Map<number, number>();
    let slots = 1;
    for (const id of group.nodeIds) {
      const col = depth.get(id) ?? 0;
      const slot = used.get(col) ?? 0;
      used.set(col, slot + 1);
      slots = Math.max(slots, slot + 1);
      placements[id] = {
        col,
        slot,
        x: LANE_LABEL_W + LANE_PAD + col * (CARD_W + GAP_X),
        y: top + LANE_PAD + slot * (CARD_H + GAP_Y),
      };
    }
    const height = LANE_PAD * 2 + slots * CARD_H + (slots - 1) * GAP_Y;
    lanes.push({ groupId: group.id, top, height, nodeIds: group.nodeIds });
    top += height + LANE_GAP;
  }
  const width = LANE_LABEL_W + LANE_PAD * 2 + columns * CARD_W + (columns - 1) * GAP_X;
  const height = Math.max(0, top - LANE_GAP);

  const arrows: SimpleArrow[] = [];
  for (const [index, e] of flows.entries()) {
    const a = placements[e.fromId];
    const b = placements[e.toId];
    if (a === undefined || b === undefined) continue;
    let path: string;
    let labelAt: { x: number; y: number };
    if (b.col > a.col) {
      const x1 = a.x + CARD_W;
      const y1 = a.y + CARD_H / 2;
      const x2 = b.x;
      const y2 = b.y + CARD_H / 2;
      const mid = (x1 + x2) / 2;
      path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
      labelAt = { x: mid, y: (y1 + y2) / 2 - 4 };
    } else {
      // Même colonne ou retour : on sort par le bas ou le haut de la carte.
      const down = b.y >= a.y;
      const x1 = a.x + CARD_W / 2;
      const y1 = down ? a.y + CARD_H : a.y;
      const x2 = b.x + CARD_W / 2;
      const y2 = down ? b.y : b.y + CARD_H;
      const dy = down ? GAP_Y * 2 : -GAP_Y * 2;
      const bulge = a.col === b.col ? 0 : (CARD_W + GAP_X) / 2;
      path = `M ${x1} ${y1} C ${x1 + bulge} ${y1 + dy}, ${x2 + bulge} ${y2 - dy}, ${x2} ${y2}`;
      labelAt = { x: (x1 + x2) / 2 + bulge / 2 + 4, y: (y1 + y2) / 2 };
    }
    arrows.push({
      key: e.id ?? `${e.fromId}>${e.toId}#${index}`,
      fromId: e.fromId,
      toId: e.toId,
      ...(e.label !== undefined && { label: e.label }),
      derived: e.derived,
      path,
      labelAt,
    });
  }
  return { width, height, columns, lanes, placements, arrows };
}

// ---------------------------------------------------------------------------------------------
// Branches et suites d'une étape
// ---------------------------------------------------------------------------------------------

export interface NextStep {
  node: OutlineNode;
  /** Condition de la branche (décision) ou libellé du flux. */
  label?: string;
  isDefault: boolean;
}

/** Étapes qui suivent `nodeId`, dans l'ordre de lecture. */
export function nextSteps(outline: DiagramOutline, nodeId: string): NextStep[] {
  const byId = new Map(outline.nodes.map((n) => [n.id, n]));
  const out: NextStep[] = [];
  for (const e of outline.edges) {
    if (e.fromId !== nodeId || (e.nature !== undefined && e.nature !== 'sequence')) continue;
    const node = byId.get(e.toId);
    if (node === undefined) continue;
    out.push({
      node,
      ...(e.label !== undefined && { label: e.label }),
      isDefault: e.isDefault === true,
    });
  }
  return out.sort((a, b) => a.node.number - b.node.number);
}

// ---------------------------------------------------------------------------------------------
// Marqueurs
// ---------------------------------------------------------------------------------------------

export interface NodeMarkers {
  hypothesis: boolean;
  /** Nombre de constats du diagnostic portant sur l'élément, et la plus grande gravité. */
  findings: number;
  severity: 0 | 1 | 2 | 3;
  /** Écarts ouverts (contradictions entre sources) sur l'élément. */
  discrepancies: number;
}

/** Marqueurs de chaque élément : hypothèse, constats (WP-21) et écarts ouverts. */
export function markersByElement(model: BusinessModel): Map<string, NodeMarkers> {
  const markers = new Map<string, NodeMarkers>();
  const of = (id: string): NodeMarkers => {
    let m = markers.get(id);
    if (m === undefined) {
      m = { hypothesis: false, findings: 0, severity: 0, discrepancies: 0 };
      markers.set(id, m);
    }
    return m;
  };
  for (const el of Object.values(model.elements)) {
    if (el.status.value === 'hypothesis') of(el.id).hypothesis = true;
    if (el.kind === 'finding') {
      for (const target of el.location) {
        const m = of(target);
        m.findings += 1;
        m.severity = Math.max(m.severity, el.severity) as NodeMarkers['severity'];
      }
    }
    if (el.kind === 'discrepancy' && el.state === 'open') {
      for (const target of el.elementIds) of(target).discrepancies += 1;
    }
  }
  return markers;
}

// ---------------------------------------------------------------------------------------------
// Fiche de l'élément sélectionné
// ---------------------------------------------------------------------------------------------

export interface ElementRef {
  id: string;
  code: string;
  label: string;
}

export interface ElementDetail {
  id: string;
  kind: Element['kind'];
  code: string;
  label: string;
  description?: string;
  status: ElementStatus;
  rationale?: string;
  origin: string;
  responsible?: ElementRef;
  /** Acteurs R, A, C, I (hors responsable principal déjà indiqué). */
  raci: { actor: ElementRef; role: string }[];
  inputs: ElementRef[];
  outputs: ElementRef[];
  tools: ElementRef[];
  rules: (ElementRef & { text: string })[];
  indicators: (ElementRef & {
    measure: string;
    value: { exact?: number | undefined; min?: number | undefined; max?: number | undefined };
    unit: string;
    period?: string | undefined;
  })[];
  findings: (ElementRef & { severity: 1 | 2 | 3 })[];
  sources: SourceRef[];
  trigger?: string;
  timer?: string;
  /** Champs d'un objet de données (nom et type). */
  fields: { name: string; type: string }[];
}

const ref = (el: Element | undefined): ElementRef | undefined =>
  el === undefined ? undefined : { id: el.id, code: el.code, label: el.label };

function refs(model: BusinessModel, ids: readonly string[] | undefined): ElementRef[] {
  const out: ElementRef[] = [];
  for (const id of ids ?? []) {
    const r = ref(model.elements[id]);
    if (r !== undefined) out.push(r);
  }
  return out;
}

/**
 * Données de la fiche d'un élément (panneau latéral, spécification 6.3) : entrées, sorties,
 * responsable, règles, indicateurs, statut et sources. Texte brut : l'interface le met en forme.
 */
export function describeElement(model: BusinessModel, id: string): ElementDetail | null {
  const el = model.elements[id];
  if (el === undefined) return null;
  const all = Object.values(model.elements);
  const detail: ElementDetail = {
    id: el.id,
    kind: el.kind,
    code: el.code,
    label: el.label,
    status: el.status.value,
    origin: el.provenance.origin,
    raci: [],
    inputs: [],
    outputs: [],
    tools: [],
    rules: [],
    indicators: [],
    findings: [],
    sources: el.provenance.refs,
    fields: [],
  };
  if (el.description !== undefined) detail.description = el.description;
  if (el.provenance.rationale !== undefined) detail.rationale = el.provenance.rationale;

  const ruleIds = new Set<string>();
  if (el.kind === 'activity') {
    const a: Activity = el;
    const responsible = ref(model.elements[a.responsibleActorId ?? '']);
    if (responsible !== undefined) detail.responsible = responsible;
    for (const r of a.raci) {
      const actor = ref(model.elements[r.actorId]);
      if (actor !== undefined && actor.id !== responsible?.id)
        detail.raci.push({ actor, role: r.role });
    }
    detail.inputs = refs(model, a.inputs);
    detail.outputs = refs(model, a.outputs);
    detail.tools = refs(model, a.toolIds);
    for (const rid of a.ruleIds) ruleIds.add(rid);
    if (a.trigger !== undefined) detail.trigger = a.trigger;
  } else if (el.kind === 'gateway') {
    if (el.ruleId !== undefined) ruleIds.add(el.ruleId);
    const actor = ref(model.elements[el.actorId ?? '']);
    if (actor !== undefined) detail.responsible = actor;
  } else if (el.kind === 'event') {
    if (el.timer !== undefined) detail.timer = el.timer;
    const actor = ref(model.elements[el.actorId ?? '']);
    if (actor !== undefined) detail.responsible = actor;
  } else if (el.kind === 'data_object') {
    detail.fields = el.fields.map((f) => ({ name: f.name, type: f.type }));
  }
  for (const other of all) {
    if (other.kind === 'rule' && other.appliesTo.includes(id)) ruleIds.add(other.id);
  }
  for (const rid of [...ruleIds].sort()) {
    const rule = model.elements[rid];
    if (rule?.kind === 'rule') {
      detail.rules.push({
        id: rule.id,
        code: rule.code,
        label: rule.label,
        text: rule.statement.text,
      });
    }
  }
  for (const other of all) {
    if (other.kind === 'indicator' && other.targetId === id) {
      detail.indicators.push({
        id: other.id,
        code: other.code,
        label: other.label,
        measure: other.measure,
        value: other.value,
        unit: other.unit,
        period: other.period,
      });
    } else if (other.kind === 'finding' && other.location.includes(id)) {
      detail.findings.push({
        id: other.id,
        code: other.code,
        label: other.label,
        severity: other.severity,
      });
    }
  }
  detail.indicators.sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }));
  detail.findings.sort((a, b) => b.severity - a.severity || a.code.localeCompare(b.code, 'fr'));
  return detail;
}

/** Texte d'une valeur d'indicateur : « 7 jours », « 3 à 5 jours »… (l'unité est celle du modèle). */
export function indicatorValue(
  value: ElementDetail['indicators'][number]['value'],
  unit: string,
): string {
  if (value.exact !== undefined) return `${value.exact} ${unit}`;
  if (value.min !== undefined && value.max !== undefined)
    return `${value.min} – ${value.max} ${unit}`;
  if (value.min !== undefined) return `≥ ${value.min} ${unit}`;
  if (value.max !== undefined) return `≤ ${value.max} ${unit}`;
  return unit;
}

/** Libellés d'étape pour les annonces : « 3. Relancer le client ». */
export const stepLabel = (node: Pick<OutlineNode, 'number' | 'label'>): string =>
  `${node.number}. ${node.label}`;
