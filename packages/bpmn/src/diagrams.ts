import type { Activity, BusinessModel, DiagramId } from '@processia/model';

export type DiagramKind = 'L0' | 'L1' | 'L2' | 'L3';

export interface ParsedDiagram {
  level: DiagramKind;
  /** Identifiant de l'activité support (macroprocessus, processus ou tâche) ; absent au niveau 0. */
  anchorId?: string;
}

export function parseDiagramId(diagram: DiagramId): ParsedDiagram | undefined {
  if (diagram === 'L0') return { level: 'L0' };
  const m = /^(L[123]):(.+)$/.exec(diagram);
  if (!m) return undefined;
  return { level: m[1] as DiagramKind, anchorId: m[2] as string };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tri stable des activités : ordre explicite, puis code, puis identifiant. */
export function sortActivities(list: Activity[]): Activity[] {
  return [...list].sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      compare(a.code, b.code) ||
      compare(a.id, b.id),
  );
}

export function activities(model: BusinessModel): Activity[] {
  return Object.values(model.elements).filter((e): e is Activity => e.kind === 'activity');
}

/**
 * Diagrammes d'un modèle (spécification 6.2) : `L0`, `L1:<macro>`, `L2:<processus>`, et `L3:<tâche>`
 * pour chaque tâche qui a des étapes. Ordre déterministe : niveau, puis code de l'activité.
 */
export function listDiagrams(model: BusinessModel): DiagramId[] {
  const acts = activities(model);
  const byCode = (level: Activity['level']): Activity[] =>
    acts
      .filter((a) => a.level === level)
      .sort((a, b) => compare(a.code, b.code) || compare(a.id, b.id));
  const hasSteps = new Set(acts.filter((a) => a.level === 'step').map((a) => a.parentId));
  return [
    'L0',
    ...byCode('macro').map((a) => `L1:${a.id}`),
    ...byCode('process').map((a) => `L2:${a.id}`),
    ...byCode('task')
      .filter((a) => hasSteps.has(a.id))
      .map((a) => `L3:${a.id}`),
  ];
}
