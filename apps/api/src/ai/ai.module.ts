import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { AiCallsService } from './ai-calls.service.js';
import { AiProviderRegistry } from './ai-provider.registry.js';
import { AiService } from './ai.service.js';

/** Couche IA côté API : registre par client, journal `ai_calls`, garde de budget (WP-09). */
@Module({
  imports: [AuthModule, ClientsModule],
  providers: [AiProviderRegistry, AiCallsService, AiService],
  exports: [AiService, AiProviderRegistry, AiCallsService],
})
export class AiModule {}
