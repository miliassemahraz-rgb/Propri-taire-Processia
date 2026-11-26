import type { Activity } from '../schema/activity.js';
import type { BusinessModel } from '../schema/business-model.js';
import type { Element } from '../schema/element.js';
import type { SequenceFlow } from '../schema/sequence-flow.js';
import type { CoherenceCode, CoherenceIssue } from './types.js';

export function elementsOfKind<K extends Element['kind']>(
  model: BusinessModel,
  kind: K,
): Extract<Element, { kind: K }>[] {
  return Object.values(model.elements).filter(
    (e): e is Extract<Element, { kind: K }> => e.kind === kind,
  );
}

/** Une activité a un responsable si `responsibleActorId` est posé ou si le RACI contient R ou A. */
export function hasOwner(a: Activity): boolean {
  return a.responsibleActorId !== undefined || a.raci.some((r) => r.role === 'R' || r.role === 'A');
}

interface ContainerGraph {
  containerId: string;
  nodes: Set<string>;
  starts: string[];
  ends: string[];
  flows: SequenceFlow[];
}

/** Graphe de séquence de chaque conteneur (processus ou tâche) qui contient des nœuds. */
export function containerGraphs(model: BusinessModel): ContainerGraph[] {
  const byContainer = new Map<string, ContainerGraph>();
  const get = (id: string): ContainerGraph => {
    let g = byContainer.get(id);
    if (!g) {
      g = { containerId: id, nodes: new Set(), starts: [], ends: [], flows: [] };
      byContainer.set(id, g);
    }
    return g;
  };
  for (const ev of elementsOfKind(model, 'event')) {
    const g = get(ev.containerId);
    g.nodes.add(ev.id);
    if (ev.position === 'start') g.starts.push(ev.id);
    if (ev.position === 'end') g.ends.push(ev.id);
  }
  for (const gw of elementsOfKind(model, 'gateway')) get(gw.containerId).nodes.add(gw.id);
  for (const fl of elementsOfKind(model, 'sequence_flow')) {
    const g = get(fl.containerId);
    g.flows.push(fl);
    g.nodes.add(fl.fromId);
    g.nodes.add(fl.toId);
  }
  return [...byContainer.values()];
}

function reach(start: Iterable<string>, edges: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length > 0) {
    const n = stack.pop() as string;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of edges.get(n) ?? []) stack.push(m);
  }
  return seen;
}

/**
 * Contrôles de cohérence (CDC 4.2 et spécification 2.5). Ce sont des avertissements : ils ne
 * bloquent jamais l'enregistrement. Un code par règle.
 */
export function checkCoherence(model: BusinessModel): CoherenceIssue[] {
  const issues: CoherenceIssue[] = [];
  const add = (
    code: CoherenceCode,
    elementId: string,
    message: string,
    relatedIds?: string[],
  ): void => {
    issues.push({
      code,
      severity: 'warning',
      elementId,
      message,
      ...(relatedIds ? { relatedIds } : {}),
    });
  };

  const activities = elementsOfKind(model, 'activity');
  const dataObjects = elementsOfKind(model, 'data_object');
  const flows = elementsOfKind(model, 'information_flow');
  const links = elementsOfKind(model, 'process_link');
  const rules = elementsOfKind(model, 'rule');
  const gateways = elementsOfKind(model, 'gateway');
  const seqFlows = elementsOfKind(model, 'sequence_flow');

  // ACTIVITY_WITHOUT_OWNER : processus et tâches sans responsable.
  for (const a of activities) {
    if ((a.level === 'process' || a.level === 'task') && !hasOwner(a)) {
      add('ACTIVITY_WITHOUT_OWNER', a.id, `L'activité « ${a.label} » n'a pas de responsable`);
    }
  }

  // DATA_NEVER_PRODUCED : entrée jamais produite, ni apportée par un flux.
  const produced = new Set<string>();
  for (const a of activities) for (const o of a.outputs) produced.add(o);
  for (const f of flows) for (const d of f.dataObjectIds) produced.add(d);
  for (const l of links) for (const d of l.dataObjectIds ?? []) produced.add(d);
  for (const a of activities) {
    const missing = a.inputs.filter((i) => !produced.has(i));
    if (missing.length > 0) {
      add(
        'DATA_NEVER_PRODUCED',
        a.id,
        `L'activité « ${a.label} » utilise des données que rien ne produit ni n'apporte`,
        missing,
      );
    }
  }

  // ORPHAN_DATA_OBJECT : objet utilisé nulle part.
  const used = new Set<string>();
  for (const a of activities) {
    for (const d of [...a.inputs, ...a.outputs]) used.add(d);
  }
  for (const f of flows) for (const d of f.dataObjectIds) used.add(d);
  for (const l of links) for (const d of l.dataObjectIds ?? []) used.add(d);
  for (const d of dataObjects) {
    for (const f of d.fields) if (f.referenceObjectId) used.add(f.referenceObjectId);
  }
  for (const d of dataObjects) {
    if (!used.has(d.id))
      add('ORPHAN_DATA_OBJECT', d.id, `L'objet « ${d.label} » n'est utilisé nulle part`);
  }

  // FLOW_UNKNOWN_CHANNEL
  for (const f of flows) {
    if (f.channel === 'unknown')
      add('FLOW_UNKNOWN_CHANNEL', f.id, `Le canal du flux « ${f.label} » est inconnu`);
  }

  // RULE_WITHOUT_SCOPE : ni `appliesTo`, ni référencée par une activité, passerelle ou flux.
  const ruleRefs = new Set<string>();
  for (const a of activities) for (const r of a.ruleIds) ruleRefs.add(r);
  for (const g of gateways) if (g.ruleId) ruleRefs.add(g.ruleId);
  for (const s of seqFlows) if (s.ruleId) ruleRefs.add(s.ruleId);
  for (const r of rules) {
    if (r.appliesTo.length === 0 && !ruleRefs.has(r.id)) {
      add('RULE_WITHOUT_SCOPE', r.id, `La règle « ${r.label} » n'a pas de portée`);
    }
  }

  // DECISION_WITHOUT_RULE : passerelle de décision (exclusive ou inclusive) sans règle.
  for (const g of gateways) {
    if (g.type !== 'parallel' && !g.ruleId) {
      add(
        'DECISION_WITHOUT_RULE',
        g.id,
        `La passerelle « ${g.label} » n'a pas de règle de décision`,
      );
    }
  }

  // GATEWAY_SINGLE_OUTGOING : ni séparation (≥ 2 sorties) ni jonction (≥ 2 entrées).
  for (const g of gateways) {
    const out = seqFlows.filter((s) => s.fromId === g.id).length;
    const inc = seqFlows.filter((s) => s.toId === g.id).length;
    if (out < 2 && inc < 2) {
      add(
        'GATEWAY_SINGLE_OUTGOING',
        g.id,
        `La passerelle « ${g.label} » n'a pas plusieurs branches`,
      );
    }
  }

  // Contrôles de graphe, conteneur par conteneur.
  const eventsById = new Map(elementsOfKind(model, 'event').map((e) => [e.id, e]));
  for (const c of containerGraphs(model)) {
    const container = model.elements[c.containerId];
    const label = container?.label ?? c.containerId;
    if (c.starts.length === 0 || c.ends.length === 0) {
      add(
        'PROCESS_WITHOUT_START_OR_END',
        c.containerId,
        `Le conteneur « ${label} » n'a pas d'événement de ${c.starts.length === 0 ? 'début' : 'fin'}`,
      );
    }
    const forward = new Map<string, string[]>();
    const backward = new Map<string, string[]>();
    const link = (from: string, to: string): void => {
      forward.set(from, [...(forward.get(from) ?? []), to]);
      backward.set(to, [...(backward.get(to) ?? []), from]);
    };
    for (const f of c.flows) link(f.fromId, f.toId);
    // Un événement de bordure part de la tâche qu'il surveille.
    for (const n of c.nodes) {
      const ev = eventsById.get(n);
      if (ev?.position === 'boundary' && ev.attachedToId) link(ev.attachedToId, ev.id);
    }
    if (c.starts.length > 0) {
      const reachable = reach(c.starts, forward);
      for (const n of c.nodes) {
        if (!reachable.has(n)) {
          add(
            'UNREACHABLE_NODE',
            n,
            `Le nœud « ${model.elements[n]?.label ?? n} » est inatteignable depuis le début`,
          );
        }
      }
    }
    if (c.ends.length > 0) {
      const canEnd = reach(c.ends, backward);
      for (const n of c.nodes) {
        if (!canEnd.has(n)) {
          add(
            'DEAD_END_BRANCH',
            n,
            `Le nœud « ${model.elements[n]?.label ?? n} » n'a aucun chemin vers une fin`,
          );
        }
      }
    }
  }

  return issues;
}
