import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { MissionPhase } from '@processia/contracts';
import type { Action } from '@processia/policy';
import type { Request } from 'express';
import type { MissionContext } from './mission-context.js';

export const CAN_KEY = 'processia:can';

/**
 * Exige le droit `action` (matrice 3.5) après la garde de session. Sur une route portant
 * `:missionId`, le droit s'évalue avec le rôle du demandeur dans cette mission.
 */
export const Can = (action: Action): MethodDecorator & ClassDecorator =>
  SetMetadata(CAN_KEY, action);

export const PHASE_KEY = 'processia:phase';

/**
 * Verrou de phase (CDC 3.6, PO-6 et PO-31) : la route n'est accessible qu'à partir de la phase
 * indiquée, sinon `409 PHASE_LOCKED`. Évalué après `@Can` (un droit refusé reste un 403).
 */
export const RequiresPhase = (phase: MissionPhase): MethodDecorator & ClassDecorator =>
  SetMetadata(PHASE_KEY, phase);

export interface MissionRequest extends Request {
  missionContext?: MissionContext;
}

/** Contexte de la mission de la route (posé par `PolicyGuard`). */
export const CurrentMission = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const ctx = context.switchToHttp().getRequest<MissionRequest>().missionContext;
  if (ctx === undefined) throw new Error('@CurrentMission() exige une route avec :missionId.');
  return ctx;
});
