import type { Activity, BusinessModel, Element } from '@processia/model';

const activities = (model: BusinessModel): Activity[] =>
  Object.values(model.elements).filter((e): e is Activity => e.kind === 'activity');

/**
 * Hypothèses rattachées à un processus (son enchaînement, ses tâches proposées, et le niveau 3 de
 * ses tâches) ou, avec `taskId`, au niveau 3 d'une tâche : nœuds, flux, étapes, et les règles,
 * indicateurs, flux d'information et objets de données qui ne visent que ces éléments. Sert aux
 * décisions groupées (confirmer ou écarter l'enchaînement d'un processus).
 */
export function flowScopeHypotheses(
  model: BusinessModel,
  processId: string,
  taskId?: string,
): Element[] {
  const all = activities(model);
  const taskIds =
    taskId === undefined
      ? all.filter((a) => a.level === 'task' && a.parentId === processId).map((a) => a.id)
      : [taskId];
  const containers = new Set(taskId === undefined ? [processId, ...taskIds] : [taskId]);
  const members = new Set<string>();
  for (const e of Object.values(model.elements)) {
    if (
      (e.kind === 'event' || e.kind === 'gateway' || e.kind === 'sequence_flow') &&
      containers.has(e.containerId)
    ) {
      members.add(e.id);
    }
    if (e.kind === 'activity' && e.level === 'step' && e.parentId !== undefined) {
      if (taskIds.includes(e.parentId)) members.add(e.id);
    }
    if (
      taskId === undefined &&
      e.kind === 'activity' &&
      e.level === 'task' &&
      e.parentId === processId
    ) {
      members.add(e.id);
    }
  }
  const targets = new Set<string>([...members, ...containers, ...taskIds]);
  const inScope = (id: string): boolean => targets.has(id);
  for (const e of Object.values(model.elements)) {
    if (e.status.value !== 'hypothesis') continue;
    if (e.kind === 'rule' && e.appliesTo.length > 0 && e.appliesTo.every(inScope)) {
      members.add(e.id);
    }
    if (e.kind === 'indicator' && inScope(e.targetId)) members.add(e.id);
    if (e.kind === 'information_flow' && e.activityId !== undefined && inScope(e.activityId)) {
      members.add(e.id);
    }
  }
  // Objets de données utilisés par ces éléments.
  const used = new Set<string>();
  for (const e of Object.values(model.elements)) {
    if (!members.has(e.id)) continue;
    if (e.kind === 'activity') for (const d of [...e.inputs, ...e.outputs]) used.add(d);
    if (e.kind === 'information_flow') for (const d of e.dataObjectIds) used.add(d);
  }
  for (const id of used) {
    if (model.elements[id]?.kind === 'data_object') members.add(id);
  }
  return [...members]
    .map((id) => model.elements[id])
    .filter((e): e is Element => e !== undefined && e.status.value === 'hypothesis')
    .sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }));
}
