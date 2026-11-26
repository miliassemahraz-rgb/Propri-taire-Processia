import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import {
  aiProviderIdSchema,
  createClientRequestSchema,
  updateClientRequestSchema,
  upsertAiConfigRequestSchema,
  uuidSchema,
  type AiConfigDto,
  type ClientDto,
  type CreateClientRequest,
  type DataPolicyDto,
  type UpdateClientRequest,
  type UpsertAiConfigRequest,
} from '@processia/contracts';
import type { Request } from 'express';
import { CurrentAuth, originOf, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can } from '../policy/decorators.js';
import { AiConfigService } from './ai-config.service.js';
import { ClientsService } from './clients.service.js';

const idPipe = new ZodPipe(uuidSchema);

@Controller('clients')
export class ClientsController {
  constructor(
    @Inject(ClientsService) private readonly clients: ClientsService,
    @Inject(AiConfigService) private readonly aiConfig: AiConfigService,
  ) {}

  /** La liste sert aussi à choisir le client d'une mission : `mission.create` suffit. */
  @Can('mission.create')
  @Get()
  list(): Promise<ClientDto[]> {
    return this.clients.list();
  }

  @Can('clients.manage')
  @Post()
  create(
    @Body(new ZodPipe(createClientRequestSchema)) body: CreateClientRequest,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<ClientDto> {
    return this.clients.create(body, auth.userId, originOf(req).ip);
  }

  @Can('clients.manage')
  @Get(':id')
  get(@Param('id', idPipe) id: string): Promise<ClientDto> {
    return this.clients.get(id);
  }

  @Can('clients.manage')
  @Patch(':id')
  update(
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(updateClientRequestSchema)) body: UpdateClientRequest,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<ClientDto> {
    return this.clients.update(id, body, auth.userId, originOf(req).ip);
  }

  @Can('ai_providers.manage')
  @Get(':id/ai-config')
  getAiConfig(@Param('id', idPipe) id: string): Promise<AiConfigDto> {
    return this.aiConfig.get(id);
  }

  /** Crée ou met à jour la configuration IA du client (une seule par client). */
  @Can('ai_providers.manage')
  @Put(':id/ai-config')
  putAiConfig(
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(upsertAiConfigRequestSchema)) body: UpsertAiConfigRequest,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<AiConfigDto> {
    return this.aiConfig.upsert(id, body, auth.userId, originOf(req).ip);
  }
}

@Controller('ai-providers')
export class AiProvidersController {
  constructor(@Inject(AiConfigService) private readonly aiConfig: AiConfigService) {}

  /** Texte de la politique de données à afficher avant l'acceptation (CDC 6.7). */
  @Can('ai_providers.manage')
  @Get(':provider/data-policy')
  dataPolicy(
    @Param('provider', new ZodPipe(aiProviderIdSchema)) provider: 'fake' | 'anthropic',
  ): DataPolicyDto {
    return this.aiConfig.dataPolicy(provider);
  }
}
