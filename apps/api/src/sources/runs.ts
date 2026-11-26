import {
  MISSION_MESSAGES_CHANNEL,
  type RunProgressMessage,
  type RunStatus,
} from '@processia/contracts';
import { analysisRuns, type MissionTx } from '@processia/db';
import { eq, sql } from 'drizzle-orm';

export const INGEST_RUN_KIND = 'ingest';

export interface RunPatch {
  status?: RunStatus;
  progress?: number;
  error?: string | null;
  jobId?: string | null;
}

/**
 * Met à jour une exécution (`analysis_runs`) et diffuse `run.progress` sur le canal
 * `mission_messages` : le `pg_notify` part à la validation de la transaction (le serveur de
 * coédition le relaiera, WP-10).
 */
export async function updateRun(
  tx: MissionTx,
  missionId: string,
  runId: string,
  sourceId: string | null,
  patch: RunPatch,
): Promise<RunProgressMessage> {
  const values = {
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.progress === undefined ? {} : { progress: patch.progress }),
    ...(patch.error === undefined ? {} : { error: patch.error }),
    ...(patch.jobId === undefined ? {} : { jobId: patch.jobId }),
  };
  const [row] =
    Object.keys(values).length === 0
      ? await tx.select().from(analysisRuns).where(eq(analysisRuns.id, runId))
      : await tx.update(analysisRuns).set(values).where(eq(analysisRuns.id, runId)).returning();
  if (row === undefined) throw new Error(`Exécution introuvable : ${runId}`);
  const message: RunProgressMessage = {
    type: 'run.progress',
    missionId,
    runId,
    kind: row.kind,
    status: row.status as RunStatus,
    progress: row.progress,
    sourceId,
    error: row.error,
  };
  await tx.execute(sql`select pg_notify(${MISSION_MESSAGES_CHANNEL}, ${JSON.stringify(message)})`);
  return message;
}
