/**
 * Projection du modèle en BPMN 2.0 (spécification 6.2) : un diagramme par niveau.
 * Les éléments sémantiques sont des objets bpmn-moddle ; la mise en page vient de `layout.ts`.
 */
import type { ModdleElement as M, BpmnModdle } from 'bpmn-moddle';
import type {
  Activity,
  Actor,
  BusinessModel,
  DataObject,
  DiagramId,
  Element,
  Gateway,
  InformationFlow,
  LayoutBox,
  ProcessEvent,
  ProcessLink,
  Rule,
  SequenceFlow,
} from '@processia/model';
import { compact, bpmnId, diagramKey } from './ids.js';
import { parseDiagramId, sortActivities } from './diagrams.js';
import type { BpmnLabels } from './labels.js';
import {
  bottom,
  layoutDiagram,
  routeVertical,
  type Box,
  type LayoutEdge,
  type LayoutNode,
  type LayoutResult,
  type Point,
} from './layout.js';

const TASK_W = 100;
const TASK_H = 80;
const EVENT_SIZE = 36;
const GATEWAY_SIZE = 50;
const DATA_W = 36;
const DATA_H = 50;
const NOTE_W = 140;
const NOTE_H = 56;
const POOL_HEADER = 30;
const BLACKBOX_W = 220;
const BLACKBOX_H = 60;

interface ShapeDef {
  el: M;
  modelId?: string;
  horizontal?: boolean;
  expanded?: boolean;
  marker?: boolean;
}
interface EdgeDef {
  el: M;
  modelId?: string;
  derived?: boolean;
}
interface ContainerOutput {
  shapes: { def: ShapeDef; box: Box }[];
  edges: { def: EdgeDef; points: Point[] }[];
}

/** Brouillon d'un diagramme : éléments sémantiques et entrée de la mise en page. */
interface Draft {
  roots: M[];
  plane: M;
  name: string;
  headerWidth: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  bands: { id: string; key?: string }[];
  shapes: Map<string, ShapeDef>;
  edgeDefs: Map<string, EdgeDef>;
  containers: (result: LayoutResult) => ContainerOutput;
}

export interface RenderedDiagram {
  roots: M[];
  diagram: M;
  /** Positions des formes qui correspondent à un élément du modèle. */
  positions: Record<string, LayoutBox>;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byCode = <T extends { code: string; id: string }>(list: T[]): T[] =>
  [...list].sort((a, b) => cmp(a.code, b.code) || cmp(a.id, b.id));

class Builder {
  readonly all: Element[];
  constructor(
    readonly moddle: BpmnModdle,
    readonly model: BusinessModel,
    readonly labels: BpmnLabels,
    readonly key: string,
  ) {
    this.all = Object.values(model.elements);
  }

  create(type: string, attrs: Record<string, unknown>, modelId?: string, derived = false): M {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) clean[k] = v;
    if (modelId !== undefined) clean['processia:elementId'] = modelId;
    if (derived) clean['processia:derived'] = true;
    return this.moddle.create(type, clean);
  }

  of<K extends Element['kind']>(kind: K): Extract<Element, { kind: K }>[] {
    return this.all.filter((e): e is Extract<Element, { kind: K }> => e.kind === kind);
  }

  actor(id: string | undefined): Actor | undefined {
    if (id === undefined) return undefined;
    const e = this.model.elements[id];
    return e?.kind === 'actor' ? e : undefined;
  }

  documentation(lines: (string | undefined)[]): M[] | undefined {
    const text = lines.filter((l): l is string => l !== undefined && l !== '').join('\n');
    return text === '' ? undefined : [this.create('bpmn:Documentation', { text })];
  }

  ruleText(r: Rule): string {
    const l = this.labels;
    const parts = [`${l.rule} ${r.code} : ${r.statement.text}`];
    if (r.statement.when) parts.push(`${l.when} : ${r.statement.when}`);
    if (r.statement.then) parts.push(`${l.then} : ${r.statement.then}`);
    if (r.statement.otherwise) parts.push(`${l.otherwise} : ${r.statement.otherwise}`);
    return parts.join(' ; ');
  }

  rulesOf(a: Activity | Gateway): Rule[] {
    const ids = new Set<string>(a.kind === 'activity' ? a.ruleIds : a.ruleId ? [a.ruleId] : []);
    const rules = this.of('rule').filter((r) => ids.has(r.id) || r.appliesTo.includes(a.id));
    return byCode(rules);
  }

  dataObjectText(d: DataObject): (string | undefined)[] {
    const l = this.labels;
    const fields = d.fields.map((f) => {
      const flags = [
        f.type,
        f.required ? l.required : undefined,
        f.personalData ? l.personalData : undefined,
      ]
        .filter(Boolean)
        .join(', ');
      return `- ${f.name} (${flags})`;
    });
    return [d.description, fields.length > 0 ? `${l.fields} :` : undefined, ...fields];
  }
}

// ---------------------------------------------------------------------------------------------
// Contenu d'un enchaînement (niveaux 1, 2 et 3)
// ---------------------------------------------------------------------------------------------

interface FlowOptions {
  childLevels: Activity['level'][];
  /** `internal` : couloirs des acteurs internes ; `all` : tous les acteurs ; `none` : une seule bande. */
  bands: 'internal' | 'all' | 'none';
  dataObjects: boolean;
  ruleMode: 'documentation' | 'annotation';
  /** Enchaîne les activités par `order` si le conteneur n'a aucun flux dans le modèle. */
  deriveChain: boolean;
  /** Utilise les événements, passerelles et flux du modèle (niveaux 2 et 3). */
  modelFlows: boolean;
}

interface FlowResult {
  flowElements: M[];
  artifacts: M[];
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  shapes: Map<string, ShapeDef>;
  edgeDefs: Map<string, EdgeDef>;
  laneActors: string[];
  hasUnassigned: boolean;
  /** Identifiant BPMN du couloir de chaque noeud. */
  bandOfNode: Map<string, string>;
  nodeEl: Map<string, M>;
  nodeBpmnId: Map<string, string>;
  activitiesList: Activity[];
  laneNodes: Map<string, M[]>;
}

const SINGLE_BAND = 'Band_main';

function buildFlow(b: Builder, container: Activity, opts: FlowOptions): FlowResult {
  const key = b.key;
  const model = b.model;
  const acts = sortActivities(
    b
      .of('activity')
      .filter((a) => a.parentId === container.id && opts.childLevels.includes(a.level)),
  );
  const events = opts.modelFlows
    ? byCode(b.of('event').filter((e) => e.containerId === container.id))
    : [];
  const gateways = opts.modelFlows
    ? byCode(b.of('gateway').filter((g) => g.containerId === container.id))
    : [];
  const flows = opts.modelFlows
    ? byCode(b.of('sequence_flow').filter((f) => f.containerId === container.id))
    : [];
  const infoFlows = b.of('information_flow');

  const nodeEl = new Map<string, M>();
  const nodeBpmnId = new Map<string, string>();
  const nodes: LayoutNode[] = [];
  const shapes = new Map<string, ShapeDef>();
  const edgeDefs = new Map<string, EdgeDef>();
  const edges: LayoutEdge[] = [];
  const flowElements: M[] = [];
  const artifacts: M[] = [];
  const bandOfNode = new Map<string, string>();
  const nodeModel = new Map<string, Activity | ProcessEvent | Gateway>();

  // --- Activités ---
  for (const a of acts) {
    const id = bpmnId('Activity', a.id);
    const attrs: Record<string, unknown> = { id, name: a.label, documentation: undefined };
    let type: string;
    if (a.level === 'process') {
      type = 'bpmn:CallActivity';
      attrs['calledElement'] = bpmnId('Process', a.id);
    } else if (a.execution === 'automatic' || a.execution === 'ai_agent') {
      type = 'bpmn:ServiceTask';
    } else if (infoFlows.some((f) => f.activityId === a.id)) {
      type = 'bpmn:SendTask';
    } else if (a.execution === 'user') {
      type = 'bpmn:UserTask';
    } else {
      type = 'bpmn:ManualTask';
    }
    const ruleLines =
      opts.ruleMode === 'documentation' ? byCode(b.rulesOf(a)).map((r) => b.ruleText(r)) : [];
    attrs['documentation'] = b.documentation([a.description, ...ruleLines]);
    const el = b.create(type, attrs, a.id);
    if (a.execution === 'ai_agent') {
      const agent = b.create('processia:AiAgent', {
        capability: a.automation?.capability,
        automationType: a.automation?.type,
      });
      el.set('extensionElements', b.create('bpmn:ExtensionElements', { values: [agent] }));
    }
    registerNode(id, el, a.id, TASK_W, TASK_H, a);
  }
  function registerNode(
    id: string,
    el: M,
    modelId: string,
    w: number,
    h: number,
    source: Activity | ProcessEvent | Gateway,
    marker?: boolean,
    role: LayoutNode['role'] = 'flow',
    anchor?: string,
  ): void {
    nodeEl.set(modelId, el);
    nodeBpmnId.set(modelId, id);
    nodeModel.set(modelId, source);
    flowElements.push(el);
    nodes.push({ id, key: modelId, w, h, band: '', role, ...(anchor !== undefined && { anchor }) });
    shapes.set(id, { el, modelId, ...(marker && { marker }) });
  }

  // --- Passerelles ---
  for (const g of gateways) {
    const type =
      g.type === 'parallel'
        ? 'bpmn:ParallelGateway'
        : g.type === 'inclusive'
          ? 'bpmn:InclusiveGateway'
          : 'bpmn:ExclusiveGateway';
    const id = bpmnId('Gateway', g.id);
    const rule = g.ruleId ? model.elements[g.ruleId] : undefined;
    const el = b.create(
      type,
      {
        id,
        name: g.label,
        documentation: b.documentation([rule?.kind === 'rule' ? b.ruleText(rule) : undefined]),
      },
      g.id,
    );
    registerNode(id, el, g.id, GATEWAY_SIZE, GATEWAY_SIZE, g, g.type === 'exclusive');
  }

  // --- Événements ---
  const placedEvents: ProcessEvent[] = [];
  for (const e of events) {
    if (
      e.position === 'boundary' &&
      (e.attachedToId === undefined || !nodeEl.has(e.attachedToId))
    ) {
      continue;
    }
    const id = bpmnId('Event', e.id);
    const defs = eventDefinitions(b, e);
    const base: Record<string, unknown> = {
      id,
      name: e.label,
      eventDefinitions: defs.length > 0 ? defs : undefined,
      documentation: b.documentation([
        e.timer !== undefined ? `${b.labels.timer} : ${e.timer}` : undefined,
      ]),
    };
    let type: string;
    switch (e.position) {
      case 'start':
        type = 'bpmn:StartEvent';
        break;
      case 'end':
        type = 'bpmn:EndEvent';
        break;
      case 'intermediate':
        type = e.trigger === 'none' ? 'bpmn:IntermediateThrowEvent' : 'bpmn:IntermediateCatchEvent';
        break;
      default:
        type = 'bpmn:BoundaryEvent';
        base['attachedToRef'] = nodeEl.get(e.attachedToId as string);
        base['cancelActivity'] = true;
    }
    const el = b.create(type, base, e.id);
    const host = e.position === 'boundary' ? nodeBpmnId.get(e.attachedToId as string) : undefined;
    registerNode(
      id,
      el,
      e.id,
      EVENT_SIZE,
      EVENT_SIZE,
      e,
      false,
      e.position === 'boundary' ? 'boundary' : 'flow',
      host,
    );
    placedEvents.push(e);
  }

  // --- Flux de séquence ---
  const outgoing = new Map<string, M[]>();
  const incoming = new Map<string, M[]>();
  const addFlow = (
    id: string,
    fromId: string,
    toId: string,
    name: string | undefined,
    modelFlow: SequenceFlow | undefined,
    derived: boolean,
  ): void => {
    const src = nodeEl.get(fromId);
    const dst = nodeEl.get(toId);
    if (!src || !dst) return;
    const attrs: Record<string, unknown> = { id, name, sourceRef: src, targetRef: dst };
    const srcType = src.$type;
    if (
      modelFlow?.condition !== undefined &&
      !modelFlow.isDefault &&
      srcType !== 'bpmn:StartEvent'
    ) {
      attrs['conditionExpression'] = b.create('bpmn:FormalExpression', {
        body: modelFlow.condition,
      });
    }
    const el = b.create('bpmn:SequenceFlow', attrs, modelFlow?.id, derived);
    if (
      modelFlow?.isDefault &&
      (srcType === 'bpmn:ExclusiveGateway' ||
        srcType === 'bpmn:InclusiveGateway' ||
        srcType.endsWith('Task') ||
        srcType === 'bpmn:CallActivity')
    ) {
      src.set('default', el);
    }
    flowElements.push(el);
    (outgoing.get(fromId) ?? outgoing.set(fromId, []).get(fromId)!).push(el);
    (incoming.get(toId) ?? incoming.set(toId, []).get(toId)!).push(el);
    edges.push({
      id,
      from: nodeBpmnId.get(fromId) as string,
      to: nodeBpmnId.get(toId) as string,
      kind: 'seq',
    });
    edgeDefs.set(id, {
      el,
      ...(modelFlow && { modelId: modelFlow.id }),
      ...(derived && { derived }),
    });
  };
  const usable = flows.filter((f) => nodeEl.has(f.fromId) && nodeEl.has(f.toId));
  for (const f of usable) {
    const from = nodeModel.get(f.fromId);
    const showName = f.condition ?? (from?.kind === 'gateway' ? f.label : undefined);
    addFlow(bpmnId('Flow', f.id), f.fromId, f.toId, showName, f, false);
  }
  if (opts.deriveChain && usable.length === 0) {
    const chain = acts.filter((a) => a.order !== undefined);
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i] as Activity;
      const c = chain[i + 1] as Activity;
      addFlow(`Flow_${compact(a.id)}_${compact(c.id)}`, a.id, c.id, undefined, undefined, true);
    }
  }
  for (const [modelId, el] of nodeEl) {
    const out = outgoing.get(modelId);
    const inc = incoming.get(modelId);
    if (inc) el.set('incoming', inc);
    if (out) el.set('outgoing', out);
  }

  // --- Couloirs ---
  const laneActors: string[] = [];
  const resolveActor = (ids: (string | undefined)[]): string | undefined => {
    for (const id of ids) {
      const actor = b.actor(id);
      if (!actor) continue;
      if (opts.bands === 'internal' && actor.category !== 'internal') continue;
      return actor.id;
    }
    return undefined;
  };
  const actorOf = new Map<string, string | undefined>();
  for (const a of acts) {
    actorOf.set(
      a.id,
      resolveActor([
        a.responsibleActorId,
        ...a.raci.filter((r) => r.role === 'R').map((r) => r.actorId),
        ...a.raci.filter((r) => r.role === 'A').map((r) => r.actorId),
      ]),
    );
  }
  for (const e of placedEvents) {
    if (e.position === 'boundary') actorOf.set(e.id, actorOf.get(e.attachedToId as string));
    else actorOf.set(e.id, resolveActor([e.actorId]));
  }
  for (const g of gateways) actorOf.set(g.id, resolveActor([g.actorId]));
  const pending = [...placedEvents.filter((e) => e.position !== 'boundary'), ...gateways];
  for (let pass = 0; pass < 6; pass++) {
    for (const n of pending) {
      if (actorOf.get(n.id) !== undefined) continue;
      const isStart = n.kind === 'event' && n.position === 'start';
      const ins = usable.filter((f) => f.toId === n.id).map((f) => actorOf.get(f.fromId));
      const outs = usable.filter((f) => f.fromId === n.id).map((f) => actorOf.get(f.toId));
      const found = (isStart ? [...outs, ...ins] : [...ins, ...outs]).find((x) => x !== undefined);
      if (found !== undefined) actorOf.set(n.id, found);
    }
  }
  const used = new Set<string>();
  let hasUnassigned = false;
  if (opts.bands !== 'none') {
    for (const id of nodeEl.keys()) {
      const actor = actorOf.get(id);
      if (actor === undefined) hasUnassigned = true;
      else used.add(actor);
    }
    if (used.size === 0) hasUnassigned = true;
    const sorted = [...used]
      .map((id) => b.actor(id) as Actor)
      .sort((p, q) => cmp(p.code, q.code) || cmp(p.id, q.id));
    laneActors.push(...sorted.map((x) => x.id));
  }
  const laneId = (actorId: string | undefined): string =>
    opts.bands === 'none'
      ? SINGLE_BAND
      : actorId === undefined
        ? `Lane_unassigned_${key}`
        : bpmnId('Lane', actorId, key);
  for (const n of nodes) {
    const modelId = n.key as string;
    const band = laneId(actorOf.get(modelId));
    n.band = band;
    bandOfNode.set(modelId, band);
  }
  // Un noeud sans acteur retombe sur la première bande si aucun couloir « non affecté » n'est créé.
  const laneNodes = new Map<string, M[]>();
  for (const n of nodes) {
    const list = laneNodes.get(n.band) ?? [];
    list.push(nodeEl.get(n.key as string) as M);
    laneNodes.set(n.band, list);
  }

  // --- Objets de données ---
  const satellites: LayoutNode[] = [];
  if (opts.dataObjects) {
    const seen = new Set<string>();
    for (const a of acts) {
      const anchor = nodeBpmnId.get(a.id) as string;
      const band = bandOfNode.get(a.id) as string;
      const actEl = nodeEl.get(a.id) as M;
      const ioIn: M[] = [];
      const ioOut: M[] = [];
      const link = (ids: string[], dir: 'in' | 'out'): void => {
        for (const doId of [...ids].sort(cmp)) {
          const d = model.elements[doId];
          if (d?.kind !== 'data_object') continue;
          const refId = bpmnId('DataObjectReference', d.id, key);
          let ref = flowElements.find((e) => e.id === refId);
          if (!seen.has(d.id)) {
            seen.add(d.id);
            const dataObject = b.create(
              'bpmn:DataObject',
              {
                id: bpmnId('DataObject', d.id, key),
                name: d.label,
                documentation: b.documentation(b.dataObjectText(d)),
              },
              d.id,
            );
            ref = b.create(
              'bpmn:DataObjectReference',
              { id: refId, name: d.label, dataObjectRef: dataObject },
              d.id,
            );
            flowElements.push(dataObject, ref);
            satellites.push({
              id: refId,
              key: d.id,
              w: DATA_W,
              h: DATA_H,
              band,
              role: 'satellite',
              anchor,
            });
            shapes.set(refId, { el: ref, modelId: d.id });
          }
          if (!ref) continue;
          const assocId = `${dir === 'in' ? 'DataInputAssociation' : 'DataOutputAssociation'}_${compact(d.id)}_${compact(a.id)}_${key}`;
          const ioId = `${dir === 'in' ? 'DataInput' : 'DataOutput'}_${compact(d.id)}_${compact(a.id)}_${key}`;
          const io = b.create(dir === 'in' ? 'bpmn:DataInput' : 'bpmn:DataOutput', {
            id: ioId,
            name: d.label,
          });
          (dir === 'in' ? ioIn : ioOut).push(io);
          const assoc =
            dir === 'in'
              ? b.create('bpmn:DataInputAssociation', {
                  id: assocId,
                  sourceRef: [ref],
                  targetRef: io,
                })
              : b.create('bpmn:DataOutputAssociation', {
                  id: assocId,
                  sourceRef: [io],
                  targetRef: ref,
                });
          const prop = dir === 'in' ? 'dataInputAssociations' : 'dataOutputAssociations';
          const current = (actEl.get(prop) as M[] | undefined) ?? [];
          actEl.set(prop, [...current, assoc]);
          edges.push({
            id: assocId,
            from: dir === 'in' ? refId : anchor,
            to: dir === 'in' ? anchor : refId,
            kind: 'assoc',
          });
          edgeDefs.set(assocId, { el: assoc });
        }
      };
      link(a.inputs, 'in');
      link(a.outputs, 'out');
      if (ioIn.length + ioOut.length > 0) {
        const suffix = `${compact(a.id)}_${key}`;
        actEl.set(
          'ioSpecification',
          b.create('bpmn:InputOutputSpecification', {
            id: `IoSpecification_${suffix}`,
            dataInputs: ioIn,
            dataOutputs: ioOut,
            inputSets: [
              b.create('bpmn:InputSet', { id: `InputSet_${suffix}`, dataInputRefs: ioIn }),
            ],
            outputSets: [
              b.create('bpmn:OutputSet', { id: `OutputSet_${suffix}`, dataOutputRefs: ioOut }),
            ],
          }),
        );
      }
    }
  }

  // --- Règles en annotations (niveau 3) ---
  if (opts.ruleMode === 'annotation') {
    const seen = new Set<string>();
    for (const a of acts) {
      const anchor = nodeBpmnId.get(a.id) as string;
      const actEl = nodeEl.get(a.id) as M;
      for (const r of b.rulesOf(a)) {
        const noteId = bpmnId('Annotation', r.id, key);
        let note = artifacts.find((x) => x.id === noteId);
        if (!seen.has(r.id)) {
          seen.add(r.id);
          note = b.create('bpmn:TextAnnotation', { id: noteId, text: b.ruleText(r) }, r.id);
          artifacts.push(note);
          satellites.push({
            id: noteId,
            key: r.id,
            w: NOTE_W,
            h: NOTE_H,
            band: bandOfNode.get(a.id) as string,
            role: 'satellite',
            anchor,
          });
          shapes.set(noteId, { el: note, modelId: r.id });
        }
        if (!note) continue;
        const assocId = `Association_${compact(r.id)}_${compact(a.id)}_${key}`;
        const assoc = b.create('bpmn:Association', {
          id: assocId,
          sourceRef: actEl,
          targetRef: note,
        });
        artifacts.push(assoc);
        edges.push({ id: assocId, from: anchor, to: noteId, kind: 'assoc' });
        edgeDefs.set(assocId, { el: assoc });
      }
    }
  }
  // Boundary d'abord après leurs hôtes, satellites en dernier.
  const ordered = [
    ...nodes.filter((n) => n.role === 'flow'),
    ...satellites,
    ...nodes.filter((n) => n.role === 'boundary'),
  ];
  return {
    flowElements,
    artifacts,
    nodes: ordered,
    edges,
    shapes,
    edgeDefs,
    laneActors,
    hasUnassigned,
    bandOfNode,
    nodeEl,
    nodeBpmnId,
    activitiesList: acts,
    laneNodes,
  };
}

function eventDefinitions(b: Builder, e: ProcessEvent): M[] {
  switch (e.trigger) {
    case 'message':
      return [b.create('bpmn:MessageEventDefinition', {})];
    case 'timer':
      return [b.create('bpmn:TimerEventDefinition', {})];
    case 'error':
      return [b.create('bpmn:ErrorEventDefinition', {})];
    case 'signal':
      return [b.create('bpmn:SignalEventDefinition', {})];
    case 'conditional':
      return [
        b.create('bpmn:ConditionalEventDefinition', {
          condition: b.create('bpmn:FormalExpression', { body: e.label }),
        }),
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Niveaux
// ---------------------------------------------------------------------------------------------

function laneSetOf(
  b: Builder,
  flow: FlowResult,
): { laneSet: M; lanes: { id: string; actorId?: string; el: M }[] } {
  const key = b.key;
  const lanes: { id: string; actorId?: string; el: M }[] = [];
  for (const actorId of flow.laneActors) {
    const actor = b.actor(actorId) as Actor;
    const id = bpmnId('Lane', actorId, key);
    const refs = flow.laneNodes.get(id) ?? [];
    lanes.push({
      id,
      actorId,
      el: b.create('bpmn:Lane', { id, name: actor.label, flowNodeRef: refs }, actorId),
    });
  }
  if (flow.hasUnassigned) {
    const id = `Lane_unassigned_${key}`;
    const refs = flow.laneNodes.get(id) ?? [];
    lanes.push({
      id,
      el: b.create('bpmn:Lane', { id, name: b.labels.unassignedLane, flowNodeRef: refs }),
    });
  }
  const laneSet = b.create('bpmn:LaneSet', { id: `LaneSet_${key}`, lanes: lanes.map((l) => l.el) });
  return { laneSet, lanes };
}

/** Niveaux 1 et 2 : participant « organisation » avec couloirs ; niveau 2 : bassins fermés et messages. */
function buildPool(b: Builder, container: Activity, level: 'L1' | 'L2'): Draft {
  const key = b.key;
  const flow = buildFlow(b, container, {
    childLevels: level === 'L1' ? ['process'] : ['task', 'process'],
    bands: level === 'L1' ? 'all' : 'internal',
    dataObjects: level === 'L2',
    ruleMode: 'documentation',
    deriveChain: level === 'L1',
    modelFlows: level === 'L2',
  });
  const { laneSet, lanes } = laneSetOf(b, flow);
  const process = b.create('bpmn:Process', {
    id: bpmnId('Process', container.id),
    name: container.label,
    isExecutable: false,
    laneSets: [laneSet],
    flowElements: flow.flowElements,
    artifacts: flow.artifacts.length > 0 ? flow.artifacts : undefined,
  });
  const orgParticipant = b.create(
    'bpmn:Participant',
    {
      id: bpmnId('Participant', container.id),
      name: level === 'L1' ? container.label : b.labels.organisation,
      processRef: process,
    },
    container.id,
  );

  // Bassins fermés (acteurs externes ou systèmes tiers) et flux de messages.
  const blackBoxes: { actorId: string; el: M }[] = [];
  const messages: {
    el: M;
    modelId: string;
    fromNode: string | undefined;
    toNode: string | undefined;
    fromActor?: string;
    toActor?: string;
  }[] = [];
  if (level === 'L2') {
    const taskIds = new Set(flow.activitiesList.map((a) => a.id));
    const outside = (id: string): Actor | undefined => {
      const a = b.actor(id);
      return a && a.category !== 'internal' ? a : undefined;
    };
    const involved = new Set<string>();
    const mf: InformationFlow[] = byCode(b.of('information_flow')).filter(
      (f) => f.activityId !== undefined && taskIds.has(f.activityId),
    );
    for (const f of mf) {
      if (outside(f.toActorId)) involved.add(f.toActorId);
      else if (outside(f.fromActorId)) involved.add(f.fromActorId);
    }
    for (const a of [container, ...flow.activitiesList]) {
      for (const r of a.raci) if (outside(r.actorId)) involved.add(r.actorId);
      if (a.responsibleActorId !== undefined && outside(a.responsibleActorId)) {
        involved.add(a.responsibleActorId);
      }
    }
    const actors = [...involved]
      .map((id) => b.actor(id) as Actor)
      .sort((p, q) => cmp(p.code, q.code) || cmp(p.id, q.id));
    const participantOf = new Map<string, M>();
    for (const actor of actors) {
      const el = b.create(
        'bpmn:Participant',
        { id: bpmnId('Participant', actor.id, key), name: actor.label },
        actor.id,
      );
      participantOf.set(actor.id, el);
      blackBoxes.push({ actorId: actor.id, el });
    }
    for (const f of mf) {
      const task = flow.nodeEl.get(f.activityId as string);
      if (!task) continue;
      const toOut = participantOf.get(f.toActorId);
      const fromOut = participantOf.get(f.fromActorId);
      const src = toOut ? task : fromOut;
      const dst = toOut ? toOut : fromOut ? task : undefined;
      if (!src || !dst || (!toOut && !fromOut)) continue;
      const el = b.create(
        'bpmn:MessageFlow',
        { id: bpmnId('MessageFlow', f.id), name: f.label, sourceRef: src, targetRef: dst },
        f.id,
      );
      messages.push({
        el,
        modelId: f.id,
        fromNode: toOut ? (f.activityId as string) : undefined,
        toNode: toOut ? undefined : (f.activityId as string),
        ...(toOut ? { toActor: f.toActorId } : { fromActor: f.fromActorId }),
      });
    }
  }
  const collaboration = b.create('bpmn:Collaboration', {
    id: `Collaboration_${key}`,
    participants: [orgParticipant, ...blackBoxes.map((x) => x.el)],
    messageFlows: messages.length > 0 ? messages.map((m) => m.el) : undefined,
  });

  const bands = [
    ...lanes.map((l) => ({ id: l.id, ...(l.actorId !== undefined && { key: l.actorId }) })),
  ];
  const containers = (r: LayoutResult): ContainerOutput => {
    const pool = r.bounds;
    const shapesOut: ContainerOutput['shapes'] = [
      { def: { el: orgParticipant, modelId: container.id, horizontal: true }, box: pool },
    ];
    for (const l of lanes) {
      const band = r.bands[l.id];
      if (!band) continue;
      shapesOut.push({
        def: { el: l.el, ...(l.actorId !== undefined && { modelId: l.actorId }), horizontal: true },
        box: { x: band.x + POOL_HEADER, y: band.y, w: band.w - POOL_HEADER, h: band.h },
      });
    }
    const boxOf = new Map<string, Box>();
    blackBoxes.forEach((x, i) => {
      const box = {
        x: pool.x + i * (BLACKBOX_W + 40),
        y: bottom(pool) + 70,
        w: BLACKBOX_W,
        h: BLACKBOX_H,
      };
      boxOf.set(x.actorId, box);
      shapesOut.push({ def: { el: x.el, modelId: x.actorId, horizontal: true }, box });
    });
    const edgesOut: ContainerOutput['edges'] = [];
    for (const m of messages) {
      const nodeId = (m.fromNode ?? m.toNode) as string;
      const nodeBox = r.nodes[flow.nodeBpmnId.get(nodeId) as string];
      const pb = boxOf.get((m.toActor ?? m.fromActor) as string);
      if (!nodeBox || !pb) continue;
      const pts = routeVertical(nodeBox, pb, true);
      edgesOut.push({
        def: { el: m.el, modelId: m.modelId },
        points: m.fromNode !== undefined ? pts : [...pts].reverse(),
      });
    }
    return { shapes: shapesOut, edges: edgesOut };
  };
  return {
    roots: [collaboration, process],
    plane: collaboration,
    name: `${container.code} ${container.label}`,
    headerWidth: POOL_HEADER * 2,
    nodes: flow.nodes,
    edges: flow.edges,
    bands,
    shapes: flow.shapes,
    edgeDefs: flow.edgeDefs,
    containers,
  };
}

/** Niveau 3 : processus dédié avec un sous-processus développé. */
function buildSubProcess(b: Builder, task: Activity): Draft {
  const flow = buildFlow(b, task, {
    childLevels: ['step'],
    bands: 'none',
    dataObjects: true,
    ruleMode: 'annotation',
    deriveChain: true,
    modelFlows: true,
  });
  const sub = b.create(
    'bpmn:SubProcess',
    {
      id: bpmnId('SubProcess', task.id),
      name: task.label,
      triggeredByEvent: false,
      flowElements: flow.flowElements,
      artifacts: flow.artifacts.length > 0 ? flow.artifacts : undefined,
      documentation: b.documentation([task.description]),
    },
    task.id,
  );
  const process = b.create('bpmn:Process', {
    id: bpmnId('Process', task.id),
    name: task.label,
    isExecutable: false,
    flowElements: [sub],
  });
  return {
    roots: [process],
    plane: process,
    name: `${task.code} ${task.label}`,
    headerWidth: 0,
    nodes: flow.nodes,
    edges: flow.edges,
    bands: [{ id: SINGLE_BAND }],
    shapes: flow.shapes,
    edgeDefs: flow.edgeDefs,
    containers: (r) => ({
      shapes: [{ def: { el: sub, modelId: task.id, expanded: true }, box: r.bounds }],
      edges: [],
    }),
  };
}

const CATEGORY_ORDER = ['steering', 'core', 'support', 'none'] as const;

/** Niveau 0 : une activité d'appel par macroprocessus, groupées par catégorie. */
function buildGlobal(b: Builder): Draft {
  const key = b.key;
  const macros = sortActivities(b.of('activity').filter((a) => a.level === 'macro'));
  const links: ProcessLink[] = byCode(b.of('process_link'));
  const flowElements: M[] = [];
  const artifacts: M[] = [];
  const nodes: LayoutNode[] = [];
  const shapes = new Map<string, ShapeDef>();
  const edges: LayoutEdge[] = [];
  const edgeDefs = new Map<string, EdgeDef>();
  const elOf = new Map<string, M>();
  const idOf = new Map<string, string>();
  const bandIdOf = (cat: string): string => `Band_${cat}`;
  for (const a of macros) {
    const id = bpmnId('Activity', a.id);
    const el = b.create(
      'bpmn:CallActivity',
      {
        id,
        name: a.label,
        calledElement: bpmnId('Process', a.id),
        documentation: b.documentation([a.description]),
      },
      a.id,
    );
    elOf.set(a.id, el);
    idOf.set(a.id, id);
    flowElements.push(el);
    nodes.push({
      id,
      key: a.id,
      w: TASK_W,
      h: TASK_H,
      band: bandIdOf(a.macroCategory ?? 'none'),
      role: 'flow',
    });
    shapes.set(id, { el, modelId: a.id });
  }
  const satellites: LayoutNode[] = [];
  const linkNature = b.labels.linkNature;
  for (const l of links) {
    const src = elOf.get(l.fromId);
    const dst = elOf.get(l.toId);
    if (!src || !dst) continue;
    if (l.nature === 'sequence') {
      const id = bpmnId('Flow', l.id);
      const el = b.create(
        'bpmn:SequenceFlow',
        { id, name: l.label, sourceRef: src, targetRef: dst },
        l.id,
      );
      flowElements.push(el);
      edges.push({
        id,
        from: idOf.get(l.fromId) as string,
        to: idOf.get(l.toId) as string,
        kind: 'seq',
      });
      edgeDefs.set(id, { el, modelId: l.id });
    } else {
      const noteId = bpmnId('Annotation', l.id);
      const target = b.model.elements[l.toId];
      const text = `${linkNature[l.nature]} : ${target?.label ?? ''}${l.label ? ` (${l.label})` : ''}`;
      const note = b.create('bpmn:TextAnnotation', { id: noteId, text }, l.id);
      const assocId = bpmnId('Association', l.id);
      const assoc = b.create('bpmn:Association', { id: assocId, sourceRef: src, targetRef: note });
      artifacts.push(note, assoc);
      const anchor = idOf.get(l.fromId) as string;
      const fromAct = b.model.elements[l.fromId];
      const cat = fromAct?.kind === 'activity' ? (fromAct.macroCategory ?? 'none') : 'none';
      satellites.push({
        id: noteId,
        key: l.id,
        w: NOTE_W,
        h: NOTE_H,
        band: bandIdOf(cat),
        role: 'satellite',
        anchor,
      });
      shapes.set(noteId, { el: note, modelId: l.id });
      edges.push({ id: assocId, from: anchor, to: noteId, kind: 'assoc' });
      edgeDefs.set(assocId, { el: assoc });
    }
  }
  const usedCats = CATEGORY_ORDER.filter((c) =>
    macros.some((a) => (a.macroCategory ?? 'none') === c),
  );
  const groups: { band: string; el: M }[] = [];
  const categories: M[] = [];
  for (const cat of usedCats) {
    if (cat === 'none') continue;
    const value = b.create('bpmn:CategoryValue', {
      id: `CategoryValue_${key}_${cat}`,
      value: b.labels.categories[cat],
    });
    categories.push(
      b.create('bpmn:Category', { id: `Category_${key}_${cat}`, categoryValue: [value] }),
    );
    const group = b.create('bpmn:Group', { id: `Group_${key}_${cat}`, categoryValueRef: value });
    artifacts.push(group);
    groups.push({ band: bandIdOf(cat), el: group });
  }
  const process = b.create('bpmn:Process', {
    id: `Process_${key}`,
    name: b.labels.globalMap,
    isExecutable: false,
    flowElements,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
  });
  return {
    roots: [...categories, process],
    plane: process,
    name: b.labels.globalMap,
    headerWidth: 0,
    nodes: [...nodes, ...satellites],
    edges,
    bands: usedCats.map((c) => ({ id: bandIdOf(c) })),
    shapes,
    edgeDefs,
    containers: (r) => ({
      shapes: groups.flatMap((g) => {
        const box = r.bands[g.band];
        return box ? [{ def: { el: g.el }, box }] : [];
      }),
      edges: [],
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Rendu : mise en page puis BPMN DI
// ---------------------------------------------------------------------------------------------

export async function renderDiagram(
  moddle: BpmnModdle,
  model: BusinessModel,
  diagram: DiagramId,
  labels: BpmnLabels,
): Promise<RenderedDiagram> {
  const parsed = parseDiagramId(diagram);
  if (!parsed) throw new Error(`Identifiant de diagramme invalide : ${diagram}`);
  const key = diagramKey(diagram);
  const b = new Builder(moddle, model, labels, key);
  let draft: Draft;
  if (parsed.level === 'L0') {
    draft = buildGlobal(b);
  } else {
    const anchor = model.elements[parsed.anchorId as string];
    const expected = parsed.level === 'L1' ? 'macro' : parsed.level === 'L2' ? 'process' : 'task';
    if (anchor?.kind !== 'activity' || anchor.level !== expected) {
      throw new Error(
        `Diagramme ${diagram} : l'élément support est absent ou n'est pas de niveau ${expected}`,
      );
    }
    draft = parsed.level === 'L3' ? buildSubProcess(b, anchor) : buildPool(b, anchor, parsed.level);
  }

  const stored = model.layout[diagram] ?? {};
  const result = await layoutDiagram({
    nodes: draft.nodes,
    edges: draft.edges,
    bands: draft.bands,
    headerWidth: draft.headerWidth,
    pinned: stored,
  });
  const container = draft.containers(result);

  const planeElements: M[] = [];
  const positions: Record<string, LayoutBox> = {};
  const shape = (def: ShapeDef, box: Box): void => {
    const attrs: Record<string, unknown> = {
      id: `${def.el.id}_di`,
      bpmnElement: def.el,
      bounds: moddle.create('dc:Bounds', { x: box.x, y: box.y, width: box.w, height: box.h }),
    };
    if (def.horizontal) attrs['isHorizontal'] = true;
    if (def.expanded) attrs['isExpanded'] = true;
    if (def.marker) attrs['isMarkerVisible'] = true;
    if (def.modelId !== undefined) attrs['processia:elementId'] = def.modelId;
    planeElements.push(moddle.create('bpmndi:BPMNShape', attrs));
  };
  const edge = (def: EdgeDef, points: Point[]): void => {
    const attrs: Record<string, unknown> = {
      id: `${def.el.id}_di`,
      bpmnElement: def.el,
      waypoint: points.map((p) => moddle.create('dc:Point', { x: p.x, y: p.y })),
    };
    if (def.modelId !== undefined) attrs['processia:elementId'] = def.modelId;
    if (def.derived) attrs['processia:derived'] = true;
    planeElements.push(moddle.create('bpmndi:BPMNEdge', attrs));
  };
  for (const c of container.shapes) shape(c.def, c.box);
  for (const n of draft.nodes) {
    const box = result.nodes[n.id];
    const def = draft.shapes.get(n.id);
    if (!box || !def) continue;
    shape(def, box);
    if (n.key !== undefined) positions[n.key] = box;
  }
  for (const band of draft.bands) {
    const box = result.bands[band.id];
    if (box && band.key !== undefined) positions[band.key] = box;
  }
  for (const e of draft.edges) {
    const points = result.edges[e.id];
    const def = draft.edgeDefs.get(e.id);
    if (points && def) edge(def, points);
  }
  for (const c of container.edges) edge(c.def, c.points);

  const plane = moddle.create('bpmndi:BPMNPlane', {
    id: `Plane_${key}`,
    bpmnElement: draft.plane,
    planeElement: planeElements,
  });
  const bpmnDiagram = moddle.create('bpmndi:BPMNDiagram', {
    id: `Diagram_${key}`,
    name: draft.name,
    plane,
  });
  return { roots: draft.roots, diagram: bpmnDiagram, positions };
}
