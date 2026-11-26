import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
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

export interface MissionRequest extends Request {
  missionContext?: MissionContext;
}

/** Contexte de la mission de la route (posé par `PolicyGuard`). */
export const CurrentMission = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const ctx = context.switchToHttp().getRequest<MissionRequest>().missionContext;
  if (ctx === undefined) throw new Error('@CurrentMission() exige une route avec :missionId.');
  return ctx;
});
