import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AiConfigService } from './ai-config.service.js';
import { AiProvidersController, ClientsController } from './clients.controller.js';
import { ClientsService } from './clients.service.js';

/** Organisations clientes et configuration du fournisseur IA par client (WP-06). */
@Module({
  imports: [AuthModule],
  controllers: [ClientsController, AiProvidersController],
  providers: [ClientsService, AiConfigService],
  exports: [AiConfigService],
})
export class ClientsModule {}
