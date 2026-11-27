import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CollabController } from './collab.controller.js';

/** Jeton de coédition (WP-10). */
@Module({ imports: [AuthModule], controllers: [CollabController] })
export class CollabModule {}
