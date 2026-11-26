import { withMission, type Database, type MissionTx } from '@processia/db';
import type { MissionRole } from '@processia/policy';

/**
 * Mission ciblée par la requête, résolue et autorisée par `PolicyGuard`. `run` ouvre la
 * transaction avec le contexte RLS (`withMission`) : seul chemin vers les tables cloisonnées.
 */
export class MissionContext {
  constructor(
    readonly missionId: string,
    readonly clientId: string,
    readonly phase: string,
    /** Rôle du demandeur dans la mission ; `null` s'il la voit sans en être membre. */
    readonly missionRole: MissionRole | null,
    private readonly db: Database,
  ) {}

  run<T>(fn: (tx: MissionTx) => Promise<T>): Promise<T> {
    return withMission(this.db, this.missionId, fn);
  }
}
