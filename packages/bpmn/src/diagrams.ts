import type { Activity, BusinessModel } from '@processia/model';

export { listDiagrams, parseDiagramId, type DiagramLevel as DiagramKind } from '@processia/model';

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
