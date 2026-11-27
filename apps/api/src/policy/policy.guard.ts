import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { missionMembers, missions, withoutMission, type Database } from '@processia/db';
import {
  can,
  canSeeMission,
  type Action,
  type GlobalRole,
  type MissionRole,
} from '@processia/policy';
import { and, eq } from 'drizzle-orm';
import { AuthError } from '../auth/errors.js';
import type { AuthedRequest } from '../auth/http.js';
import { DB } from '../db/db.module.js';
import { MISSION_PHASES, type MissionPhase } from '@processia/contracts';
import { CAN_KEY, PHASE_KEY, type MissionRequest } from './decorators.js';
import { MissionContext } from './mission-context.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Garde globale des droits, évaluée après `SessionGuard`.
 *
 *  - Route sans `:missionId` : `@Can(action)` est évalué avec le rôle global.
 *  - Route avec `:missionId` (`MissionGuard`, spécification 3.3) : la mission doit être visible
 *    (administrateur et responsables de mission : toutes [PO-22] ; consultant et validateur : celles
 *    où ils sont affectés), sinon 404 (jamais 403, pour ne rien révéler) ; puis `@Can(action)` est
 *    évalué avec le rôle dans la mission (403 si refusé). Le contexte est exposé via
 *    `@CurrentMission()`.
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<AuthedRequest & MissionRequest>();
    const action = this.reflector.getAllAndOverride<Action | undefined>(CAN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const params = request.params as Record<string, string | undefined>;
    const missionId = params['missionId'];
    if (action === undefined && missionId === undefined) return true;

    const auth = request.auth;
    if (auth === undefined) throw new AuthError('UNAUTHENTICATED');
    const globalRole = auth.user.globalRole as GlobalRole;

    if (missionId === undefined) {
      if (action !== undefined && !can({ globalRole }, action)) throw new AuthError('FORBIDDEN');
      return true;
    }

    if (!UUID_RE.test(missionId)) throw new AuthError('NOT_FOUND');
    const found = await withoutMission(this.db, async (tx) => {
      const [mission] = await tx
        .select({ id: missions.id, clientId: missions.clientId, phase: missions.phase })
        .from(missions)
        .where(eq(missions.id, missionId))
        .limit(1);
      if (mission === undefined) return null;
      const [member] = await tx
        .select({ role: missionMembers.missionRole })
        .from(missionMembers)
        .where(and(eq(missionMembers.missionId, missionId), eq(missionMembers.userId, auth.userId)))
        .limit(1);
      return { mission, role: (member?.role ?? null) as MissionRole | null };
    });
    if (found === null) throw new AuthError('NOT_FOUND');
    const subject = { globalRole, missionRole: found.role };
    if (!canSeeMission(subject)) throw new AuthError('NOT_FOUND');
    // Un validateur membre d'une mission n'a affaire qu'à ses propres soumissions.
    if (action !== undefined && !can(subject, action, { own: found.role === 'validator' })) {
      throw new AuthError('FORBIDDEN');
    }
    const required = this.reflector.getAllAndOverride<MissionPhase | undefined>(PHASE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (
      required !== undefined &&
      MISSION_PHASES.indexOf(found.mission.phase as MissionPhase) < MISSION_PHASES.indexOf(required)
    ) {
      throw new AuthError('PHASE_LOCKED', { requiredPhase: required, phase: found.mission.phase });
    }
    request.missionContext = new MissionContext(
      found.mission.id,
      found.mission.clientId,
      found.mission.phase,
      found.role,
      this.db,
    );
    return true;
  }
}
