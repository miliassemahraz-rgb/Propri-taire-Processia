import type { FlowOverviewDto, FlowProcessDto } from '@processia/contracts';

/** Cartographie (WP-17) : fonctions pures de la page des enchaînements. */

export interface MacroGroup {
  macroCode: string;
  macroLabel: string;
  processes: FlowProcessDto[];
}

/** Processus regroupés par macroprocessus, dans l'ordre des codes (`P04.2` avant `P04.10`). */
export function groupByMacro(processes: FlowProcessDto[]): MacroGroup[] {
  const groups = new Map<string, MacroGroup>();
  const sorted = [...processes].sort((a, b) =>
    a.code.localeCompare(b.code, 'fr', { numeric: true }),
  );
  for (const process of sorted) {
    const key = process.macroCode === '' ? process.macroLabel : process.macroCode;
    const group = groups.get(key) ?? {
      macroCode: process.macroCode,
      macroLabel: process.macroLabel,
      processes: [],
    };
    group.processes.push(process);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.macroCode.localeCompare(b.macroCode, 'fr', { numeric: true }),
  );
}

export interface FlowCounts {
  total: number;
  built: number;
  toBuild: number;
  pending: number;
}

/** Compteurs de l'en-tête : processus construits, à construire, éléments à examiner. */
export function flowCounts(overview: FlowOverviewDto | null): FlowCounts {
  const processes = overview?.processes ?? [];
  const built = processes.filter((p) => p.flowBuilt).length;
  return {
    total: processes.length,
    built,
    toBuild: processes.length - built,
    pending: processes.reduce(
      (sum, p) => sum + p.pendingCount + p.tasks.reduce((n, task) => n + task.pendingCount, 0),
      0,
    ),
  };
}

/** Éléments à examiner d'un processus, niveau 3 de ses tâches compris. */
export const processPending = (process: FlowProcessDto): number =>
  process.pendingCount + process.tasks.reduce((sum, task) => sum + task.pendingCount, 0);

/** Les phases de la mission où la cartographie est ouverte (à partir de la phase « mapping »). */
export const mappingOpen = (phase: string): boolean => phase !== 'analysis';
