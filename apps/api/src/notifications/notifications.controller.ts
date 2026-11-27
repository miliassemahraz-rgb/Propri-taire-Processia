import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { NotificationDto } from '@processia/contracts';
import { z } from 'zod';
import { CurrentAuth, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { NotificationsService } from './notifications.service.js';

const markReadSchema = z.object({ ids: z.array(z.string().uuid()).max(200).optional() });

/** Centre de notifications du compte connecté (WP-16) : liste et marquage « lu ». */
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly service: NotificationsService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<NotificationDto[]> {
    return this.service.list(auth.user.id);
  }

  @HttpCode(200)
  @Post('read')
  async read(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(markReadSchema)) body: z.infer<typeof markReadSchema>,
  ): Promise<{ updated: number }> {
    return { updated: await this.service.markRead(auth.user.id, body.ids) };
  }
}
