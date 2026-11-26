import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import {
  updateUserRequestSchema,
  uuidSchema,
  type UpdateUserRequest,
  type UserSummary,
} from '@processia/contracts';
import type { Request } from 'express';
import { CurrentAuth, originOf, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can } from '../policy/decorators.js';
import { UsersService } from './users.service.js';

const idPipe = new ZodPipe(uuidSchema);

@Controller('users')
@Can('users.manage')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  list(): Promise<UserSummary[]> {
    return this.users.list();
  }

  @Get(':id')
  get(@Param('id', idPipe) id: string): Promise<UserSummary> {
    return this.users.get(id);
  }

  @Post(':id/unlock')
  @HttpCode(200)
  unlock(
    @Param('id', idPipe) id: string,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<UserSummary> {
    return this.users.unlock(id, auth.userId, originOf(req).ip);
  }

  @Patch(':id')
  update(
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(updateUserRequestSchema)) body: UpdateUserRequest,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<UserSummary> {
    return this.users.update(id, body, auth.userId, originOf(req).ip);
  }
}
