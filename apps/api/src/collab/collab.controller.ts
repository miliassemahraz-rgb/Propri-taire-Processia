import { Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import {
  COLLAB_TOKEN_AUDIENCE,
  COLLAB_TOKEN_ISSUER,
  COLLAB_TOKEN_TTL_SECONDS,
  type CollabTokenResponse,
} from '@processia/contracts';
import { can, type GlobalRole } from '@processia/policy';
import { SignJWT } from 'jose';
import { CurrentAuth } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { ENV } from '../env.js';
import { Can, CurrentMission } from '../policy/decorators.js';
import { MissionContext } from '../policy/mission-context.js';

/**
 * Jeton court (JWT HS256, 10 minutes) pour se connecter au serveur de coédition. Il n'accorde
 * rien par lui-même : le serveur de coédition revérifie l'appartenance et le rôle à chaque
 * connexion (spécification 5, ADR 0004).
 */
@Controller('missions/:missionId')
export class CollabController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @Can('mission.read_workspace')
  @HttpCode(200)
  @Post('collab-token')
  async token(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<CollabTokenResponse> {
    const expiresAt = new Date(Date.now() + COLLAB_TOKEN_TTL_SECONDS * 1000);
    const token = await new SignJWT({ mid: ctx.missionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(auth.user.id)
      .setIssuer(COLLAB_TOKEN_ISSUER)
      .setAudience(COLLAB_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(new TextEncoder().encode(this.env.COLLAB_JWT_SECRET));
    const subject = {
      globalRole: auth.user.globalRole as GlobalRole,
      missionRole: ctx.missionRole,
    };
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      url: this.env.COLLAB_PUBLIC_URL,
      canEdit: can(subject, 'model.edit'),
    };
  }
}
