import { z } from 'zod';

/** Contrats de la construction des enchaînements des processus, niveaux 2 et 3 (WP-17). */

/** Genre de l'exécution `analysis_runs` d'un lot d'enchaînements. */
export const FLOW_RUN_KIND = 'process_flow' as const;

/**
 * Lancement du job `process.flow` : `processIds` omis = tous les processus sans enchaînement ;
 * `detailTaskIds` = tâches dont on construit le niveau 3 (mode « détail »). Les deux ne se
 * combinent pas : un lot construit soit les enchaînements, soit le détail de tâches.
 */
export const startFlowSchema = z
  .object({
    processIds: z.array(z.string().uuid()).max(500).optional(),
    detailTaskIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  })
  .refine((v) => v.processIds === undefined || v.detailTaskIds === undefined, {
    message: 'Enchaînements et détail de tâches ne se lancent pas ensemble.',
  });
export type StartFlowRequest = z.infer<typeof startFlowSchema>;

export interface StartFlowResult {
  runId: string;
}

export interface FlowTaskDto {
  id: string;
  code: string;
  label: string;
  /** Le niveau 3 de la tâche existe (au moins une étape). */
  detailed: boolean;
  /** Éléments du niveau 3 encore à l'état d'hypothèse. */
  pendingCount: number;
}

export interface FlowProcessDto {
  id: string;
  code: string;
  label: string;
  macroCode: string;
  macroLabel: string;
  /** Le processus a un enchaînement (événements, passerelles, flux de séquence). */
  flowBuilt: boolean;
  tasks: FlowTaskDto[];
  /** Éléments d'enchaînement du processus encore à l'état d'hypothèse. */
  pendingCount: number;
  nodeCount: number;
}

/** Échec d'un processus ou d'une tâche lors du dernier lot (code, motif). */
export interface FlowFailureDto {
  code: string;
  error: string;
}

export interface FlowOverviewDto {
  processes: FlowProcessDto[];
  /** Exécution du lot en cours ou la plus récente. */
  lastRun: {
    runId: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    progress: number;
    failures: FlowFailureDto[];
  } | null;
}

/** Décision groupée sur l'enchaînement d'un processus (confirmer ou écarter ses hypothèses). */
export const flowDecisionSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  /** Niveau 3 d'une tâche (sinon : le processus lui-même). */
  taskId: z.string().uuid().optional(),
});
export type FlowDecisionRequest = z.infer<typeof flowDecisionSchema>;

export interface FlowDecisionResult {
  version: number;
  count: number;
  outcome: 'confirmed' | 'rejected';
}
