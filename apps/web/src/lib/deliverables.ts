import type { ExportFormat, RunStatus } from '@processia/contracts';
import type { BusinessModel } from '@processia/model';

/** Livrables de l'étape 1 et exports (WP-15) : fonctions pures de l'interface. */

export const EXPORT_FORMATS_ORDER: readonly ExportFormat[] = ['docx', 'pdf', 'xlsx'];

/** Identifiant d'ancre d'un livrable (navigation interne de la page). */
export const deliverableAnchor = (sectionId: string): string => `livrable-${sectionId}`;

/** Empreinte abrégée (mode simple) ; l'empreinte complète s'affiche en mode expert. */
export function shortSha(sha256: string): string {
  return sha256.length <= 12 ? sha256 : `${sha256.slice(0, 12)}…`;
}

/** Nombre d'hypothèses encore en attente de décision : elles n'entrent dans aucun livrable. */
export function pendingHypothesisCount(model: BusinessModel | null): number {
  if (model === null) return 0;
  return Object.values(model.elements).filter((e) => e.status.value === 'hypothesis').length;
}

export interface ExportRunState {
  runId: string;
  format: ExportFormat;
  status: RunStatus;
  progress: number;
}

export const isExportActive = (run: Pick<ExportRunState, 'status'>): boolean =>
  run.status === 'queued' || run.status === 'running';

/** Une exécution terminée ne redevient jamais active sur un message tardif. */
export function mergeExportRun(
  runs: Record<string, ExportRunState>,
  update: { runId: string; status: RunStatus; progress: number },
): Record<string, ExportRunState> {
  const current = runs[update.runId];
  if (current === undefined) return runs;
  if (!isExportActive(current) && isExportActive(update)) return runs;
  return {
    ...runs,
    [update.runId]: { ...current, status: update.status, progress: update.progress },
  };
}

/** Format en cours de production, s'il y en a un (un bouton par format est alors désactivé). */
export function busyFormats(runs: Record<string, ExportRunState>): Set<ExportFormat> {
  return new Set(
    Object.values(runs)
      .filter(isExportActive)
      .map((run) => run.format),
  );
}
