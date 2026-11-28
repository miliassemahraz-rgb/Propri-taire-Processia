/** Contrats du diagnostic de l'AS-IS (WP-21). Les constats eux-mêmes se lisent dans le modèle partagé. */

/** Genre de l'exécution `analysis_runs` du diagnostic. */
export const DIAGNOSTIC_RUN_KIND = 'diagnostic' as const;

/** Échec d'un macroprocessus lors de la dernière exécution (code, motif). */
export interface DiagnosticFailureDto {
  code: string;
  error: string;
}

export interface DiagnosticOverviewDto {
  /** Macroprocessus de l'AS-IS qui ont des tâches : le périmètre du diagnostic. */
  macroCount: number;
  /** Constats (détecteurs et IA) déjà dans le modèle, tous statuts confondus. */
  findingCount: number;
  /** Exécution en cours ou la plus récente. */
  lastRun: {
    runId: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    progress: number;
    /** Version du modèle écrite par la dernière exécution, s'il y en a une. */
    resultVersion: number | null;
    failures: DiagnosticFailureDto[];
  } | null;
}

export interface StartDiagnosticResult {
  runId: string;
}
