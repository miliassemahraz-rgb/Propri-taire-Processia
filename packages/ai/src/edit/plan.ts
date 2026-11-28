import {
  applyChangeSet,
  parseDiagramId,
  planRemoval,
  type Activity,
  type BusinessModel,
  type ChangeSet,
  type Element,
  type ModelOp,
  type Provenance,
  type SequenceFlow,
} from '@processia/model';
import { normalizeForMatch } from '../extraction/text.js';
import type {
  EditAction,
  EditInput,
  EditPlan,
  EditScope,
  EditScopeNode,
} from '../pipelines/model-edit.js';

const norm = normalizeForMatch;
const MAX_ACTORS = 60;
const MAX_PROCESSES = 80;
const MAX_TASKS = 12;
const MAX_NODES = 80;
const MAX_FLOWS = 160;
const MAX_HISTORY = 6;

const byCode = (a: { code: string }, b: { code: string }): number =>
  a.code.localeCompare(b.code, 'fr', { numeric: true });
const byOrder = (a: Activity, b: Activity): number =>
  (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || byCode(a, b);

const activities = (model: BusinessModel): Activity[] =>
  Object.values(model.elements).filter((e): e is Activity => e.kind === 'activity');

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

function processOf(model: BusinessModel, a: Activity): Activity | undefined {
  let current: Activity | undefined = a;
  for (let i = 0; i < 10 && current !== undefined; i += 1) {
    if (current.level === 'process') return current;
    const parent: Element | undefined =
      current.parentId === undefined ? undefined : model.elements[current.parentId];
    current = parent?.kind === 'activity' ? parent : undefined;
  }
  return undefined;
}

const actorLabel = (model: BusinessModel, id: string | undefined): string | undefined => {
  const e = id === undefined ? undefined : model.elements[id];
  return e?.kind === 'actor' ? e.label : undefined;
};

// ------------------------------------------------------------------ contexte réduit

export interface BuildEditInputArgs {
  model: BusinessModel;
  instruction: string;
  /** Échanges précédents du fil, du plus ancien au plus récent. */
  history: { role: 'user' | 'assistant'; content: string }[];
  /** Diagramme affiché (`L0`, `L1:<id>`…) ; `L0` par défaut. */
  diagram?: string;
  selectedId?: string | null;
}

function scopeOf(model: BusinessModel, container: Activity): EditScope {
  const all = Object.values(model.elements);
  const nodes: EditScopeNode[] = [];
  const codeOf = (id: string): string => model.elements[id]?.code ?? id;
  const level = container.level === 'process' ? 'task' : 'step';
  for (const e of all) {
    if (e.kind === 'activity' && e.level === level && e.parentId === container.id) {
      const actor = actorLabel(model, e.responsibleActorId);
      nodes.push({
        code: e.code,
        kind: level,
        label: e.label,
        container: container.code,
        ...(actor === undefined ? {} : { actor }),
      });
    } else if (e.kind === 'event' && e.containerId === container.id) {
      const actor = actorLabel(model, e.actorId);
      nodes.push({
        code: e.code,
        kind: 'event',
        label: e.label,
        container: container.code,
        position: e.position,
        ...(actor === undefined ? {} : { actor }),
      });
    } else if (e.kind === 'gateway' && e.containerId === container.id) {
      const actor = actorLabel(model, e.actorId);
      nodes.push({
        code: e.code,
        kind: 'gateway',
        label: e.label,
        container: container.code,
        gatewayType: e.type,
        ...(actor === undefined ? {} : { actor }),
      });
    }
  }
  nodes.sort(byCode);
  const inScope = new Set(
    all
      .filter(
        (e) =>
          nodes.some((n) => n.code === e.code) &&
          (e.kind === 'activity' || e.kind === 'event' || e.kind === 'gateway'),
      )
      .map((e) => e.id),
  );
  inScope.add(container.id);
  const flows = all
    .filter((e): e is SequenceFlow => e.kind === 'sequence_flow' && e.containerId === container.id)
    .sort(byCode)
    .map((f) => ({
      code: f.code,
      from: codeOf(f.fromId),
      to: codeOf(f.toId),
      ...(f.condition === undefined ? {} : { condition: f.condition }),
    }));
  const rules = all
    .flatMap((e) => (e.kind === 'rule' && e.appliesTo.some((id) => inScope.has(id)) ? [e] : []))
    .sort(byCode)
    .map((r) => ({ code: r.code, label: r.label, type: r.type }));
  const indicators = all
    .flatMap((e) => (e.kind === 'indicator' && inScope.has(e.targetId) ? [e] : []))
    .sort(byCode)
    .map((i) => ({
      code: i.code,
      label: i.label,
      target: codeOf(i.targetId),
      measure: i.measure,
      value: JSON.stringify(i.value),
      unit: i.unit,
    }));
  return {
    code: container.code,
    label: container.label,
    nodes: nodes.slice(0, MAX_NODES),
    flows: flows.slice(0, MAX_FLOWS),
    rules: rules.slice(0, 40),
    indicators: indicators.slice(0, 40),
  };
}

/**
 * Entrée de `model.edit` : contexte réduit au processus visé (spécification 7, risque R-2). Au
 * niveau 2 ou 3, le détail du processus (nœuds, flux, règles, indicateurs) ; aux niveaux 0 et 1,
 * seulement la liste compacte des processus et de leurs tâches. L'IA désigne ensuite les éléments
 * par leur code ; `buildEditChangeSet` les résout sur le modèle entier.
 */
export function buildEditInput(args: BuildEditInputArgs): EditInput {
  const { model } = args;
  const diagram = args.diagram ?? 'L0';
  const parsed = parseDiagramId(diagram);
  const anchor = parsed?.anchorId === undefined ? undefined : model.elements[parsed.anchorId];
  const anchorActivity = anchor?.kind === 'activity' ? anchor : undefined;
  const all = activities(model);
  const processes = all
    .filter((a) => a.level === 'process')
    .filter((p) => {
      if (anchorActivity === undefined || parsed?.level === 'L0') return true;
      if (parsed?.level === 'L1') return macroOf(model, p)?.id === anchorActivity.id;
      return processOf(model, anchorActivity)?.id === p.id;
    })
    .sort(byCode)
    .slice(0, MAX_PROCESSES);
  let scope: EditScope | undefined;
  if (anchorActivity !== undefined && (parsed?.level === 'L2' || parsed?.level === 'L3')) {
    scope = scopeOf(model, anchorActivity);
  }
  const selected =
    args.selectedId === undefined ? undefined : model.elements[args.selectedId ?? ''];
  return {
    instruction: args.instruction,
    history: args.history.slice(-MAX_HISTORY),
    focus: {
      diagram,
      ...(anchorActivity === undefined
        ? {}
        : { code: anchorActivity.code, label: anchorActivity.label }),
      ...(selected === undefined
        ? {}
        : { selected: { code: selected.code, label: selected.label } }),
    },
    actors: Object.values(model.elements)
      .flatMap((e) => (e.kind === 'actor' ? [e] : []))
      .sort(byCode)
      .slice(0, MAX_ACTORS)
      .map((a) => ({ code: a.code, label: a.label, category: a.category })),
    processes: processes.map((p) => ({
      code: p.code,
      label: p.label,
      macro: macroOf(model, p)?.label ?? '',
      tasks: all
        .filter((a) => a.level === 'task' && a.parentId === p.id)
        .sort(byOrder)
        .slice(0, MAX_TASKS)
        .map((t) => {
          const actor = actorLabel(model, t.responsibleActorId);
          return { code: t.code, label: t.label, ...(actor === undefined ? {} : { actor }) };
        }),
    })),
    ...(scope === undefined ? {} : { scope }),
  };
}

// ------------------------------------------------------------------ plan → ChangeSet

export type EditErrorCode = 'EDIT_UNKNOWN_TARGET' | 'EDIT_UNSUPPORTED' | 'EDIT_INVALID';

/** Plan impossible à traduire : le dialogue l'explique au consultant, rien n'est proposé. */
export class EditPlanError extends Error {
  constructor(
    readonly code: EditErrorCode,
    readonly issues: { path: string; message: string }[],
  ) {
    super(`${code} : ${issues.map((i) => i.message).join(' ')}`.slice(0, 500));
    this.name = 'EditPlanError';
  }
}

export interface BuildEditArgs {
  model: BusinessModel;
  plan: EditPlan;
  /** Consigne du consultant : sert de justification aux éléments créés et de résumé. */
  instruction: string;
  userId: string | null;
  aiCallId: string | null;
  /** Instant des provenances (ISO). */
  at: string;
}

export interface EditBuild {
  changeSet: ChangeSet;
  /** Éléments existants que le ChangeSet modifie ou retire (pour l'aperçu). */
  touchedIds: string[];
}

const SUMMARY_MAX = 140;

/**
 * ChangeSet `dialogue_edit` d'un plan d'édition. Tout élément créé est `confirmed`, d'origine
 * `consultant` : l'application de la proposition par le consultant est la décision humaine. Les
 * éléments existants que l'on corrige (renommer, réaffecter, changer un indicateur) passent
 * aussi à `confirmed`, avec la valeur précédente en `correction`. Les enchaînements sont recâblés
 * (insertion, retrait) sans jamais laisser un flux orphelin ; le résultat est revérifié par
 * `applyChangeSet`.
 */
export function buildEditChangeSet(args: BuildEditArgs): EditBuild {
  const { model, plan, at } = args;
  const fail = (code: EditErrorCode, path: string, message: string): never => {
    throw new EditPlanError(code, [{ path, message }]);
  };
  if (plan.actions.length === 0) fail('EDIT_INVALID', 'actions', 'Aucune action à appliquer.');

  const byElementCode = new Map<string, Element>();
  for (const e of Object.values(model.elements)) byElementCode.set(e.code, e);
  const actorByLabel = new Map<string, string>();
  for (const e of Object.values(model.elements)) {
    if (e.kind === 'actor') actorByLabel.set(norm(e.label), e.id);
  }
  const find = (code: string, path: string): Element => {
    const e = byElementCode.get(code);
    if (e === undefined) return fail('EDIT_UNKNOWN_TARGET', path, `Élément inconnu : ${code}.`);
    return e;
  };
  const actorId = (label: string, path: string): string => {
    const id = actorByLabel.get(norm(label));
    if (id === undefined) return fail('EDIT_INVALID', path, `Acteur inconnu : « ${label} ».`);
    return id;
  };

  const rationale = `Consigne : « ${args.instruction.trim().slice(0, 400)} »`;
  const provenance = (): Provenance => ({
    origin: 'consultant',
    refs: [],
    rationale,
    ...(args.aiCallId === null ? {} : { aiCallId: args.aiCallId }),
    author: { type: 'user', ...(args.userId === null ? {} : { userId: args.userId }) },
    at,
  });
  const common = () => ({
    code: '',
    provenance: provenance(),
    status: {
      value: 'confirmed' as const,
      ...(args.userId === null ? {} : { decidedBy: args.userId }),
      decidedAt: at,
    },
    meta: { createdInVersion: 0, updatedInVersion: 0 },
  });

  const ops: ModelOp[] = [];
  const touched = new Set<string>();
  const claimed = new Map<string, Set<string>>();
  const removed = new Set<string>();
  let counter = 0;
  const tmp = (): string => `tmp:${(counter += 1)}`;
  const flows = Object.values(model.elements).filter(
    (e): e is SequenceFlow => e.kind === 'sequence_flow',
  );

  /** Une même valeur ne peut pas être écrite par deux actions : le consultant les sépare. */
  const claim = (id: string, fields: string[], path: string): void => {
    const set = claimed.get(id) ?? new Set<string>();
    for (const f of fields) {
      if (set.has(f) || removed.has(id)) {
        fail(
          'EDIT_UNSUPPORTED',
          path,
          `Deux actions modifient « ${model.elements[id]?.label ?? id} » : formulez-les séparément.`,
        );
      }
      set.add(f);
    }
    claimed.set(id, set);
    touched.add(id);
  };
  const update = (
    id: string,
    set: Record<string, unknown>,
    path: string,
    unset?: string[],
  ): void => {
    claim(id, [...Object.keys(set), ...(unset ?? [])], path);
    ops.push({ op: 'update', id, set, ...(unset === undefined ? {} : { unset }) });
  };
  /** Correction par le consultant : l'élément décidé passe à `confirmed` avec l'ancienne valeur. */
  const confirm = (el: Element, previous: Record<string, unknown>): void => {
    if (el.status.value === 'hypothesis' || el.status.value === 'extracted') {
      ops.push({ op: 'set_status', id: el.id, status: 'confirmed', correction: previous });
    }
  };

  const containerOf = (el: Element, path: string): Activity => {
    const id =
      el.kind === 'activity'
        ? el.parentId
        : el.kind === 'event' || el.kind === 'gateway'
          ? el.containerId
          : undefined;
    const container = id === undefined ? undefined : model.elements[id];
    if (
      container?.kind !== 'activity' ||
      (container.level !== 'process' && container.level !== 'task')
    ) {
      return fail(
        'EDIT_UNSUPPORTED',
        path,
        `« ${el.label} » n'est pas dans un enchaînement modifiable.`,
      );
    }
    return container;
  };
  const isNode = (el: Element): boolean =>
    (el.kind === 'activity' && (el.level === 'task' || el.level === 'step')) ||
    el.kind === 'event' ||
    el.kind === 'gateway';

  const nextOrder = (containerId: string): number =>
    1 +
    Math.max(
      0,
      ...activities(model)
        .filter((a) => a.parentId === containerId)
        .map((a) => a.order ?? 0),
    );

  const pendingRuleIds = new Map<string, string[]>();

  plan.actions.forEach((action: EditAction, index) => {
    const path = `actions.${index}`;
    switch (action.action) {
      case 'insert_task': {
        const anchor = find(action.anchor, `${path}.anchor`);
        if (!isNode(anchor)) {
          fail(
            'EDIT_UNSUPPORTED',
            `${path}.anchor`,
            `On n'insère rien à côté de « ${anchor.label} ».`,
          );
        }
        const container = containerOf(anchor, `${path}.anchor`);
        const level = container.level === 'process' ? 'task' : 'step';
        const inContainer = flows.filter((f) => f.containerId === container.id);
        const edges =
          action.placement === 'after'
            ? inContainer.filter((f) => f.fromId === anchor.id)
            : inContainer.filter((f) => f.toId === anchor.id);
        if (edges.length === 0) {
          fail(
            'EDIT_UNSUPPORTED',
            `${path}.anchor`,
            action.placement === 'after'
              ? `« ${anchor.label} » n'a pas de suite : on ne peut rien insérer après.`
              : `« ${anchor.label} » n'a pas d'étape précédente : on ne peut rien insérer avant.`,
          );
        }
        const owner =
          action.actor === undefined ? undefined : actorId(action.actor, `${path}.actor`);
        const id = tmp();
        ops.push({
          op: 'add',
          element: {
            ...common(),
            id,
            kind: 'activity',
            label: action.label,
            ...(action.description === undefined ? {} : { description: action.description }),
            level,
            parentId: container.id,
            order: nextOrder(container.id),
            ...(owner === undefined ? {} : { responsibleActorId: owner }),
            raci: owner === undefined ? [] : [{ actorId: owner, role: 'R' as const }],
            inputs: [],
            outputs: [],
            toolIds: [],
            ruleIds: [],
            execution: action.execution ?? 'manual',
          },
        });
        touched.add(anchor.id);
        for (const edge of edges) {
          const other = action.placement === 'after' ? edge.toId : edge.fromId;
          const otherLabel = model.elements[other]?.label ?? other;
          if (action.placement === 'after') {
            update(edge.id, { toId: id }, path);
            ops.push({
              op: 'add',
              element: {
                ...common(),
                id: tmp(),
                kind: 'sequence_flow',
                label: `${action.label} → ${otherLabel}`,
                containerId: container.id,
                fromId: id,
                toId: other,
              },
            });
          } else {
            update(edge.id, { toId: id }, path);
            ops.push({
              op: 'add',
              element: {
                ...common(),
                id: tmp(),
                kind: 'sequence_flow',
                label: `${action.label} → ${anchor.label}`,
                containerId: container.id,
                fromId: id,
                toId: anchor.id,
              },
            });
          }
        }
        return;
      }
      case 'reassign': {
        const target = find(action.target, `${path}.target`);
        const owner = actorId(action.actor, `${path}.actor`);
        if (target.kind === 'activity' && (target.level === 'task' || target.level === 'step')) {
          const raci = [
            ...target.raci.filter((r) => r.role !== 'R'),
            { actorId: owner, role: 'R' as const },
          ];
          update(target.id, { responsibleActorId: owner, raci }, path);
          confirm(target, { responsibleActorId: target.responsibleActorId ?? null });
        } else if (target.kind === 'event' || target.kind === 'gateway') {
          update(target.id, { actorId: owner }, path);
          confirm(target, { actorId: target.actorId ?? null });
        } else {
          fail('EDIT_UNSUPPORTED', `${path}.target`, `On ne réaffecte pas « ${target.label} ».`);
        }
        return;
      }
      case 'rename': {
        const target = find(action.target, `${path}.target`);
        const set: Record<string, unknown> = {};
        const previous: Record<string, unknown> = {};
        if (action.label !== undefined && action.label !== target.label) {
          set['label'] = action.label;
          previous['label'] = target.label;
        }
        if (action.description !== undefined && action.description !== target.description) {
          set['description'] = action.description;
          previous['description'] = target.description ?? null;
        }
        if (Object.keys(set).length === 0) {
          fail('EDIT_INVALID', path, `Rien à changer pour « ${target.label} ».`);
        }
        update(target.id, set, path);
        confirm(target, previous);
        return;
      }
      case 'remove': {
        const target = find(action.target, `${path}.target`);
        const removable = isNode(target) || target.kind === 'rule' || target.kind === 'indicator';
        if (!removable) {
          fail(
            'EDIT_UNSUPPORTED',
            `${path}.target`,
            `On ne supprime pas « ${target.label} » par dialogue.`,
          );
        }
        claim(target.id, ['*'], path);
        // Reconnexion : les flux qui arrivent sur l'élément sont redirigés vers sa suite.
        const work: BusinessModel = { ...model, elements: { ...model.elements } };
        const reconnect: ModelOp[] = [];
        if (isNode(target)) {
          const container = containerOf(target, `${path}.target`);
          const inc = flows.filter((f) => f.containerId === container.id && f.toId === target.id);
          const out = flows.filter((f) => f.containerId === container.id && f.fromId === target.id);
          if (out.length > 1 && inc.length > 0) {
            fail(
              'EDIT_UNSUPPORTED',
              `${path}.target`,
              `« ${target.label} » a plusieurs suites : dites vers quelle étape raccorder les précédentes.`,
            );
          }
          const next = out[0];
          if (next !== undefined) {
            for (const flow of inc) {
              if (flow.fromId === next.toId) continue;
              claim(flow.id, ['toId'], path);
              reconnect.push({ op: 'update', id: flow.id, set: { toId: next.toId } });
              work.elements[flow.id] = { ...flow, toId: next.toId };
            }
          }
        }
        const plan_ = planRemoval(work, [target.id], { reason: 'Retiré par dialogue' });
        for (const id of plan_.removed) {
          if (id !== target.id) claim(id, ['*'], path);
          removed.add(id);
        }
        touched.add(target.id);
        ops.push(...reconnect, ...plan_.ops);
        return;
      }
      case 'add_exception': {
        const target = find(action.target, `${path}.target`);
        if (target.kind !== 'activity' || (target.level !== 'task' && target.level !== 'step')) {
          fail(
            'EDIT_UNSUPPORTED',
            `${path}.target`,
            `Une exception se rattache à une tâche ou une étape.`,
          );
          return;
        }
        const id = tmp();
        ops.push({
          op: 'add',
          element: {
            ...common(),
            id,
            kind: 'rule',
            label: action.label,
            type: 'exception',
            statement: {
              text: action.text,
              ...(action.when === undefined ? {} : { when: action.when }),
              ...(action.then === undefined ? {} : { then: action.then }),
              ...(action.otherwise === undefined ? {} : { otherwise: action.otherwise }),
            },
            appliesTo: [target.id],
            exceptionHandling: {
              circuit: action.circuit,
              description: action.circuitDescription,
              activityIds: [target.id],
            },
          },
        });
        pendingRuleIds.set(target.id, [...(pendingRuleIds.get(target.id) ?? []), id]);
        touched.add(target.id);
        return;
      }
      case 'set_indicator': {
        const target = find(action.target, `${path}.target`);
        const value =
          action.exact !== undefined
            ? { exact: action.exact }
            : {
                ...(action.min === undefined ? {} : { min: action.min }),
                ...(action.max === undefined ? {} : { max: action.max }),
              };
        if (Object.keys(value).length === 0) {
          fail('EDIT_INVALID', path, 'Une valeur est nécessaire pour un indicateur.');
        }
        let indicator: Element | undefined = target.kind === 'indicator' ? target : undefined;
        if (indicator === undefined && target.kind === 'activity' && action.measure !== undefined) {
          indicator = Object.values(model.elements).find(
            (e) =>
              e.kind === 'indicator' && e.targetId === target.id && e.measure === action.measure,
          );
        }
        if (indicator?.kind === 'indicator') {
          const set: Record<string, unknown> = { value };
          if (action.unit !== undefined) set['unit'] = action.unit;
          if (action.label !== undefined) set['label'] = action.label;
          update(indicator.id, set, path);
          confirm(indicator, { value: indicator.value, unit: indicator.unit });
          return;
        }
        if (
          target.kind === 'activity' &&
          action.measure !== undefined &&
          action.unit !== undefined
        ) {
          ops.push({
            op: 'add',
            element: {
              ...common(),
              id: tmp(),
              kind: 'indicator',
              label: action.label ?? `${target.label} : ${action.measure}`,
              targetId: target.id,
              measure: action.measure,
              value,
              unit: action.unit,
              nature: 'known',
            },
          });
          touched.add(target.id);
          return;
        }
        fail(
          'EDIT_INVALID',
          `${path}.target`,
          'Pour créer un indicateur, précisez la mesure et l’unité ; sinon indiquez le code d’un indicateur existant.',
        );
        return;
      }
    }
  });

  for (const [id, added] of pendingRuleIds) {
    const activity = model.elements[id] as Activity;
    update(id, { ruleIds: [...activity.ruleIds, ...added] }, 'actions');
  }

  const changeSet: ChangeSet = {
    baseVersion: model.version,
    ops,
    cause: 'dialogue_edit',
    summary: `Dialogue : ${args.instruction.trim().replace(/\s+/g, ' ').slice(0, SUMMARY_MAX)}`,
  };
  const applied = applyChangeSet(model, changeSet, { at, actor: 'consultant' });
  if (!applied.ok) {
    throw new EditPlanError(
      'EDIT_INVALID',
      applied.errors.map((e) => ({ path: e.path ?? e.code, message: e.message })),
    );
  }
  return { changeSet, touchedIds: [...touched].sort() };
}
