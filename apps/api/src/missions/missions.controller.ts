import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  assignMemberRequestSchema,
  createMissionRequestSchema,
  updateMissionRequestSchema,
  uuidSchema,
  type AssignableUser,
  type AssignMemberRequest,
  type CreateMissionRequest,
  type CreateMissionResponse,
  type MemberDto,
  type MissionSummary,
  type UpdateMissionRequest,
} from '@processia/contracts';
import type { Request } from 'express';
import { CurrentAuth, originOf, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can, CurrentMission } from '../policy/decorators.js';
import { MissionContext } from '../policy/mission-context.js';
import { MissionsService } from './missions.service.js';

/**
 * Routes des missions. Celles qui portent `:missionId` traversent `PolicyGuard` : mission non
 * visible = 404, droit insuffisant = 403.
 */
@Controller('missions')
export class MissionsController {
  constructor(@Inject(MissionsService) private readonly missions: MissionsService) {}

  /** Liste de suivi : les missions visibles du demandeur, avec leur avancement. */
  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<MissionSummary[]> {
    return this.missions.list(auth);
  }

  @Can('mission.create')
  @Post()
  create(
    @Body(new ZodPipe(createMissionRequestSchema)) body: CreateMissionRequest,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<CreateMissionResponse> {
    return this.missions.create(body, auth, originOf(req).ip);
  }

  /** Visible par tout membre (le validateur compris) ; l'avancement est omis pour lui. */
  @Get(':missionId')
  get(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<MissionSummary> {
    return this.missions.get(ctx, auth);
  }

  /** Nom, description et phase : gestion de la mission, comme l'affectation. */
  @Can('mission.assign')
  @Patch(':missionId')
  update(
    @CurrentMission() ctx: MissionContext,
    @Body(new ZodPipe(updateMissionRequestSchema)) body: UpdateMissionRequest,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<MissionSummary> {
    return this.missions.update(ctx, body, auth, originOf(req).ip);
  }

  @Can('mission.view_progress')
  @Get(':missionId/members')
  members(@CurrentMission() ctx: MissionContext): Promise<MemberDto[]> {
    return this.missions.members(ctx);
  }

  @Can('mission.assign')
  @Get(':missionId/assignable-users')
  assignable(): Promise<AssignableUser[]> {
    return this.missions.assignableUsers();
  }

  @Can('mission.assign')
  @Put(':missionId/members')
  assign(
    @CurrentMission() ctx: MissionContext,
    @Body(new ZodPipe(assignMemberRequestSchema)) body: AssignMemberRequest,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<MemberDto[]> {
    return this.missions.assign(ctx, body, auth, originOf(req).ip);
  }

  @Can('mission.assign')
  @Delete(':missionId/members/:userId')
  @HttpCode(204)
  async unassign(
    @CurrentMission() ctx: MissionContext,
    @Param('userId', new ZodPipe(uuidSchema)) userId: string,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<void> {
    await this.missions.unassign(ctx, userId, auth, originOf(req).ip);
  }
}
