import {
  applyChangeSet,
  type Activity,
  type BusinessModel,
  type ChangeSet,
  type Element,
  type ModelOp,
  type Provenance,
} from '@processia/model';
import {
  checkProcessFlow,
  FLOW_PROCESS_CONTAINER,
  type FlowTaskInfo,
  type ProcessFlowInput,
  type ProcessFlowOutput,
} from '../pipelines/process-flow.js';
import { normalizeForMatch } from '../extraction/text.js';

const norm = normalizeForMatch;
const MAX_ACTORS = 60;
const MAX_REUSABLE = 40;

const byOrder = (a: Activity, b: Activity): number =>
  (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
  a.code.localeCompare(b.code, 'fr', { numeric: true });

const activities = (model: BusinessModel): Activity[] =>
  Object.values(model.elements).filter((e): e is Activity => e.kind === 'activity');

/** Éléments qui participent à l'enchaînement d'un conteneur (processus ou tâche). */
function containedIn(model: BusinessModel, containerId: string): Element[] {
  return Object.values(model.elements).filter(
    (e) =>
      (e.kind === 'event' || e.kind === 'gateway' || e.kind === 'sequence_flow') &&
      e.containerId === containerId,
  );
}

/** Vrai si le processus a déjà un enchaînement (événement, passerelle ou flux de séquence). */
export const hasProcessFlow = (model: BusinessModel, processId: string): boolean =>
  containedIn(model, processId).length > 0;

/** Vrai si la tâche a déjà un niveau 3 (au moins une étape). */
export const hasTaskDetail = (model: BusinessModel, taskId: string): boolean =>
  activities(model).some((a) => a.level === 'step' && a.parentId === taskId);

export interface FlowProcessEntry {
  id: string;
  code: string;
  label: string;
  macroCode: string;
  macroLabel: string;
  flowBuilt: boolean;
  tasks: { id: string; code: string; label: string; detailed: boolean; pendingCount: number }[];
  /** Éléments d'enchaînement encore à l'état d'hypothèse (processus et tâches détaillées). */
  pendingCount: number;
  /** Éléments d'enchaînement au total. */
  nodeCount: number;
}

function macroOf(model: BusinessModel, a: Activity): Activity | undefined {
  let current: Activity | undefined = a;
  for (let i = 0; i < 10 && current !== undefined; i += 1) {
    if (current.level === 'macro') return current;
    const parent: Element | undefined =
      current.parentId === undefined ? undefined : model.elements[current.parentId];
    current = parent?.kind === 'activity' ? parent : undefined;
  }
  return undefined;
}

/** Processus du modèle (niveau 2), par code, avec l'état de leur enchaînement. */
export function listFlowProcesses(model: BusinessModel): FlowProcessEntry[] {
  const all = activities(model);
  const pending = (id: string): number =>
    containedIn(model, id).filter((e) => e.status.value === 'hypothesis').length;
  return all
    .filter((a) => a.level === 'process')
    .sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }))
    .map((p) => {
      const macro = macroOf(model, p);
      const tasks = all
        .filter((a) => a.level === 'task' && a.parentId === p.id)
        .sort(byOrder)
        .map((t) => ({
          id: t.id,
          code: t.code,
          label: t.label,
          detailed: hasTaskDetail(model, t.id),
          pendingCount:
            pending(t.id) +
            all.filter(
              (s) => s.level === 'step' && s.parentId === t.id && s.status.value === 'hypothesis',
            ).length,
        }));
      const nodes = containedIn(model, p.id);
      return {
        id: p.id,
        code: p.code,
        label: p.label,
        macroCode: macro?.code ?? '',
        macroLabel: macro?.label ?? '',
        flowBuilt: nodes.length > 0,
        tasks,
        pendingCount: pending(p.id),
        nodeCount: nodes.length,
      };
    });
}

function taskInfo(model: BusinessModel, a: Activity): FlowTaskInfo {
  const responsible =
    a.responsibleActorId === undefined ? undefined : model.elements[a.responsibleActorId];
  return {
    code: a.code,
    label: a.label,
    ...(a.description === undefined ? {} : { description: a.description }),
    ...(responsible === undefined ? {} : { actor: responsible.label }),
  };
}

/**
 * Entrée de `process.flow` : contexte réduit au processus visé (spécification 7, risque R-2) :
 * ses tâches, les acteurs, et les règles et objets de données à réutiliser.
 */
export function buildProcessFlowInput(
  model: BusinessModel,
  processId: string,
  mode: 'flow' | 'detail',
  detailTaskIds: readonly string[] = [],
): ProcessFlowInput {
  const process = model.elements[processId];
  if (process === undefined || process.kind !== 'activity' || process.level !== 'process') {
    throw new Error(`Processus introuvable : ${processId}`);
  }
  const all = activities(model);
  const tasks = all.filter((a) => a.level === 'task' && a.parentId === processId).sort(byOrder);
  const detail = tasks.filter((t) => detailTaskIds.includes(t.id));
  const scope = new Set([processId, ...tasks.map((t) => t.id)]);
  return {
    mode,
    process: {
      code: process.code,
      label: process.label,
      ...(process.description === undefined ? {} : { description: process.description }),
      macro: macroOf(model, process)?.label ?? '',
    },
    tasks: tasks.map((t) => taskInfo(model, t)),
    detailTasks: mode === 'detail' ? detail.map((t) => taskInfo(model, t)) : [],
    actors: Object.values(model.elements)
      .flatMap((e) => (e.kind === 'actor' ? [e] : []))
      .sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }))
      .slice(0, MAX_ACTORS)
      .map((a) => ({ code: a.code, label: a.label, category: a.category })),
    rules: Object.values(model.elements)
      .flatMap((e) => (e.kind === 'rule' && e.appliesTo.some((id) => scope.has(id)) ? [e] : []))
      .sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }))
      .slice(0, MAX_REUSABLE)
      .map((r) => ({ code: r.code, label: r.label, type: r.type })),
    dataObjects: Object.values(model.elements)
      .flatMap((e) => (e.kind === 'data_object' ? [e] : []))
      .sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }))
      .slice(0, MAX_REUSABLE)
      .map((d) => ({ code: d.code, label: d.label })),
  };
}

/** Erreur d'un enchaînement proposé : refusé sans rien écrire (le modèle reste inchangé). */
export class ProcessFlowError extends Error {
  constructor(
    readonly code: 'FLOW_INVALID' | 'FLOW_INCOHERENT' | 'FLOW_REJECTED',
    readonly issues: { path: string; message: string }[],
  ) {
    super(`${code} : ${issues.map((i) => i.message).join(' ')}`.slice(0, 500));
    this.name = 'ProcessFlowError';
  }
}

export interface FlowStats {
  created: number;
  createdByKind: Record<string, number>;
}

export interface FlowBuild {
  /** `null` : rien à écrire (enchaînement déjà présent). */
  changeSet: ChangeSet | null;
  stats: FlowStats;
}

export interface BuildFlowInput {
  model: BusinessModel;
  processId: string;
  mode: 'flow' | 'detail';
  detailTaskIds?: readonly string[];
  output: ProcessFlowOutput;
  aiCallId: string | null;
  /** Instant des provenances (ISO). */
  at: string;
  /** Identifiants persistants des champs de données (un champ n'accepte pas `tmp:n`). */
  newId: () => string;
}

const STRUCTURE_CODES = new Set([
  'DEAD_END_BRANCH',
  'UNREACHABLE_NODE',
  'PROCESS_WITHOUT_START_OR_END',
]);

/**
 * ChangeSet `process_flow` : tous les éléments créés sont des hypothèses (`ai_knowledge`, avec
 * justification), jamais confirmés ; aucun élément existant n'est modifié. Le graphe est
 * revérifié ici (contrôle sémantique, puis cohérence du modèle résultant) : un enchaînement
 * qui laisserait une impasse n'est jamais écrit.
 */
export function buildProcessFlowChangeSet(input: BuildFlowInput): FlowBuild {
  const { model, processId, mode, output, at } = input;
  const empty: FlowBuild = { changeSet: null, stats: { created: 0, createdByKind: {} } };
  const detailIds = input.detailTaskIds ?? [];
  if (mode === 'flow' && hasProcessFlow(model, processId)) return empty;
  const detailTargets =
    mode === 'detail' ? detailIds.filter((id) => !hasTaskDetail(model, id)) : [];
  if (mode === 'detail' && detailTargets.length === 0) return empty;

  const flowInput = buildProcessFlowInput(model, processId, mode, detailTargets);
  if (mode === 'detail' && flowInput.detailTasks.length === 0) return empty;
  const issues = checkProcessFlow(output, flowInput);
  if (issues.length > 0) throw new ProcessFlowError('FLOW_INVALID', issues);

  const idByCode = new Map<string, string>();
  for (const e of Object.values(model.elements)) idByCode.set(e.code, e.id);
  const actorByLabel = new Map<string, string>();
  for (const e of Object.values(model.elements)) {
    if (e.kind === 'actor') actorByLabel.set(norm(e.label), e.id);
  }
  const actorId = (label: string | undefined): string | undefined =>
    label === undefined ? undefined : actorByLabel.get(norm(label));

  const tmp = new Map<string, string>();
  let counter = 0;
  const claim = (ref: string): string => {
    counter += 1;
    const id = `tmp:${counter}`;
    tmp.set(ref, id);
    return id;
  };
  const resolve = (ref: string): string => {
    const id = tmp.get(ref) ?? idByCode.get(ref);
    if (id === undefined)
      throw new ProcessFlowError('FLOW_INVALID', [
        { path: ref, message: `Référence inconnue : ${ref}.` },
      ]);
    return id;
  };
  const containerId = (container: string): string =>
    container === FLOW_PROCESS_CONTAINER ? processId : resolve(container);

  const provenance = (rationale?: string): Provenance => ({
    origin: 'ai_knowledge',
    refs: [],
    rationale: rationale ?? output.rationale,
    ...(input.aiCallId === null ? {} : { aiCallId: input.aiCallId }),
    author: { type: 'ai' },
    at,
  });
  const common = (rationale?: string) => ({
    code: '',
    provenance: provenance(rationale),
    status: { value: 'hypothesis' as const },
    meta: { createdInVersion: 0, updatedInVersion: 0 },
  });

  const ops: ModelOp[] = [];
  const stats: FlowStats = { created: 0, createdByKind: {} };
  const push = (element: Element): void => {
    ops.push({ op: 'add', element });
    stats.created += 1;
    stats.createdByKind[element.kind] = (stats.createdByKind[element.kind] ?? 0) + 1;
  };

  // Les identifiants temporaires sont attribués d'abord (références croisées).
  for (const r of output.rules) claim(r.ref);
  for (const d of output.dataObjects) claim(d.ref);
  for (const n of output.nodes) claim(n.ref);
  for (const x of output.indicators) claim(x.ref);

  const labelOf = (ref: string): string => {
    const node = output.nodes.find((n) => n.ref === ref);
    if (node !== undefined) return node.label;
    const existing = model.elements[idByCode.get(ref) ?? ''];
    return existing?.label ?? ref;
  };

  for (const r of output.rules) {
    push({
      ...common(r.rationale),
      id: tmp.get(r.ref) as string,
      kind: 'rule',
      label: r.label,
      type: r.type,
      statement: {
        text: r.text,
        ...(r.when === undefined ? {} : { when: r.when }),
        ...(r.then === undefined ? {} : { then: r.then }),
        ...(r.otherwise === undefined ? {} : { otherwise: r.otherwise }),
      },
      appliesTo: r.appliesTo.map(resolve),
      ...(r.type === 'exception' && r.circuit !== undefined && r.circuitDescription !== undefined
        ? { exceptionHandling: { circuit: r.circuit, description: r.circuitDescription } }
        : {}),
      ...(r.legalReference === undefined ? {} : { legalReference: r.legalReference }),
    });
  }
  for (const d of output.dataObjects) {
    push({
      ...common(d.rationale),
      id: tmp.get(d.ref) as string,
      kind: 'data_object',
      label: d.label,
      nature: d.nature,
      toolIds: [],
      fields: d.fields.map((f) => ({
        id: input.newId(),
        name: f.name,
        type: f.type,
        ...(f.required === undefined ? {} : { required: f.required }),
        ...(f.enumValues === undefined ? {} : { enumValues: f.enumValues }),
        ...(f.description === undefined ? {} : { description: f.description }),
        ...(f.personalData === undefined ? {} : { personalData: f.personalData }),
        provenance: provenance(d.rationale),
        status: { value: 'hypothesis' as const },
      })),
    });
  }

  const siblings = new Map<string, number>();
  for (const n of output.nodes) {
    const id = tmp.get(n.ref) as string;
    const rationale = n.rationale;
    const description = n.description === undefined ? {} : { description: n.description };
    if (n.kind === 'task' || n.kind === 'step') {
      const parentId = containerId(n.container);
      const order = (siblings.get(parentId) ?? 0) + 1;
      siblings.set(parentId, order);
      const owner = actorId(n.actor);
      push({
        ...common(rationale),
        id,
        kind: 'activity',
        label: n.label,
        ...description,
        level: n.kind,
        parentId,
        order,
        ...(owner === undefined ? {} : { responsibleActorId: owner }),
        raci: owner === undefined ? [] : [{ actorId: owner, role: 'R' as const }],
        inputs: (n.inputs ?? []).map(resolve),
        outputs: (n.outputs ?? []).map(resolve),
        toolIds: [],
        ruleIds: output.rules.filter((r) => r.appliesTo.includes(n.ref)).map((r) => resolve(r.ref)),
        execution: n.execution ?? 'manual',
      });
    } else if (n.kind === 'event') {
      const owner = actorId(n.actor);
      push({
        ...common(rationale),
        id,
        kind: 'event',
        label: n.label,
        ...description,
        containerId: containerId(n.container),
        position: n.position ?? 'intermediate',
        trigger: n.trigger ?? 'none',
        ...(n.position === 'boundary' && n.attachedTo !== undefined
          ? { attachedToId: resolve(n.attachedTo) }
          : {}),
        ...(owner === undefined ? {} : { actorId: owner }),
        ...(n.timer === undefined ? {} : { timer: n.timer }),
      });
    } else {
      const owner = actorId(n.actor);
      push({
        ...common(rationale),
        id,
        kind: 'gateway',
        label: n.label,
        ...description,
        containerId: containerId(n.container),
        type: n.gatewayType ?? 'exclusive',
        ...(n.rule === undefined ? {} : { ruleId: resolve(n.rule) }),
        ...(owner === undefined ? {} : { actorId: owner }),
      });
    }
  }
  for (const e of output.edges) {
    push({
      ...common(),
      id: `tmp:${(counter += 1)}`,
      kind: 'sequence_flow',
      label: e.condition ?? `${labelOf(e.from)} → ${labelOf(e.to)}`,
      containerId: containerId(e.container),
      fromId: resolve(e.from),
      toId: resolve(e.to),
      ...(e.condition === undefined ? {} : { condition: e.condition }),
      ...(e.rule === undefined ? {} : { ruleId: resolve(e.rule) }),
      ...(e.isDefault === undefined ? {} : { isDefault: e.isDefault }),
    });
  }
  for (const x of output.indicators) {
    push({
      ...common(x.rationale),
      id: tmp.get(x.ref) as string,
      kind: 'indicator',
      label: x.label,
      targetId: resolve(x.target),
      measure: x.measure,
      value: {
        ...(x.exact === undefined ? {} : { exact: x.exact }),
        ...(x.min === undefined ? {} : { min: x.min }),
        ...(x.max === undefined ? {} : { max: x.max }),
      },
      unit: x.unit,
      ...(x.period === undefined ? {} : { period: x.period }),
      nature: x.nature,
    });
  }
  for (const f of output.informationFlows) {
    const from = actorId(f.from);
    const to = actorId(f.to);
    if (from === undefined || to === undefined) continue;
    push({
      ...common(f.rationale),
      id: `tmp:${(counter += 1)}`,
      kind: 'information_flow',
      label: f.label,
      fromActorId: from,
      toActorId: to,
      dataObjectIds: f.dataObjects.map(resolve),
      channel: f.channel,
      ...(f.activity === undefined ? {} : { activityId: resolve(f.activity) }),
      ...(f.frequency === undefined ? {} : { frequency: f.frequency }),
    });
  }

  const label =
    mode === 'flow'
      ? `Enchaînement du processus ${flowInput.process.code} « ${flowInput.process.label} »`
      : `Niveau 3 : ${flowInput.detailTasks.map((t) => t.code).join(', ')}`;
  const changeSet: ChangeSet = {
    baseVersion: model.version,
    ops,
    cause: 'process_flow',
    summary: `${label} (${stats.created} hypothèse(s))`,
  };

  // Vérification sur le modèle résultant : aucune impasse, aucun nœud inatteignable.
  const applied = applyChangeSet(model, changeSet, { at, actor: 'ai' });
  if (!applied.ok) {
    throw new ProcessFlowError(
      'FLOW_INVALID',
      applied.errors.map((e) => ({ path: e.path ?? e.code, message: e.message })),
    );
  }
  const structural = applied.warnings.filter((w) => STRUCTURE_CODES.has(w.code));
  if (structural.length > 0) {
    throw new ProcessFlowError(
      'FLOW_INCOHERENT',
      structural.map((w) => ({ path: w.code, message: w.message })),
    );
  }
  return { changeSet, stats };
}
