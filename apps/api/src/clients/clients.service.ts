import { Inject, Injectable } from '@nestjs/common';
import type { ClientDto, CreateClientRequest, UpdateClientRequest } from '@processia/contracts';
import { clients, type Database } from '@processia/db';
import { asc, eq } from 'drizzle-orm';
import { AuthError } from '../auth/errors.js';
import { AuditService } from '../auth/services.js';
import { DB } from '../db/db.module.js';

type ClientRow = typeof clients.$inferSelect;

function toDto(row: ClientRow): ClientDto {
  return {
    id: row.id,
    name: row.name,
    defaultRetentionMonths: row.defaultRetentionMonths,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Organisations clientes. */
@Injectable()
export class ClientsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(): Promise<ClientDto[]> {
    return (await this.db.select().from(clients).orderBy(asc(clients.name))).map(toDto);
  }

  async get(id: string): Promise<ClientDto> {
    const [row] = await this.db.select().from(clients).where(eq(clients.id, id)).limit(1);
    if (row === undefined) throw new AuthError('NOT_FOUND');
    return toDto(row);
  }

  async create(input: CreateClientRequest, actorId: string, ip: string | null): Promise<ClientDto> {
    const [row] = await this.db
      .insert(clients)
      .values({
        name: input.name,
        ...(input.defaultRetentionMonths === undefined
          ? {}
          : { defaultRetentionMonths: input.defaultRetentionMonths }),
      })
      .returning();
    if (row === undefined) throw new Error('Client non créé.');
    await this.audit.record({
      actorId,
      action: 'client.created',
      target: `client:${row.id}`,
      payload: { name: row.name },
      ip,
    });
    return toDto(row);
  }

  async update(
    id: string,
    input: UpdateClientRequest,
    actorId: string,
    ip: string | null,
  ): Promise<ClientDto> {
    const [row] = await this.db
      .update(clients)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.defaultRetentionMonths === undefined
          ? {}
          : { defaultRetentionMonths: input.defaultRetentionMonths }),
      })
      .where(eq(clients.id, id))
      .returning();
    if (row === undefined) throw new AuthError('NOT_FOUND');
    await this.audit.record({
      actorId,
      action: 'client.updated',
      target: `client:${id}`,
      payload: { changes: Object.keys(input) },
      ip,
    });
    return toDto(row);
  }
}
