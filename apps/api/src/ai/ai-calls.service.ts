import { Inject, Injectable } from '@nestjs/common';
import type { AiCallEntry, AiJournal, BudgetPort } from '@processia/ai';
import {
  aiCalls,
  missions,
  withMission,
  withoutMission,
  type Database,
  type Json,
} from '@processia/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../auth/services.js';
import { DB } from '../db/db.module.js';

/** Premier instant du mois civil courant (UTC) : fenêtre du budget mensuel. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Journal `ai_calls` et consommation mensuelle. Les lignes d'une mission ne sont visibles que
 * sous le contexte de cette mission ; celles sans mission, seulement avec `aiUnscoped` (RLS).
 * PO-23 : requêtes et réponses sont conservées pendant la durée de vie de la mission.
 */
@Injectable()
export class AiCallsService implements AiJournal, BudgetPort {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(entry: AiCallEntry): Promise<string | null> {
    const values = {
      missionId: entry.missionId,
      clientId: entry.clientId,
      pipeline: entry.pipeline,
      pipelineVersion: entry.pipelineVersion,
      provider: entry.provider,
      model: entry.model,
      inputHash: entry.inputHash,
      request: entry.request as Json,
      response: entry.response as Json,
      status: entry.status,
      error: entry.error,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costEstimateEur: entry.costEstimateEur.toFixed(6),
      durationMs: entry.durationMs,
      createdBy: entry.createdBy,
    };
    const insert = async (tx: Database): Promise<string | null> => {
      const [row] = await tx.insert(aiCalls).values(values).returning({ id: aiCalls.id });
      return row?.id ?? null;
    };
    if (entry.missionId !== null) {
      return withMission(this.db, entry.missionId, (tx) => insert(tx as unknown as Database));
    }
    return withoutMission(this.db, (tx) => insert(tx as unknown as Database), {
      aiUnscoped: true,
    });
  }

  /**
   * Dépense du mois civil pour un client, toutes missions confondues. La RLS ne montre que la
   * mission du contexte : on additionne mission par mission, puis les appels hors mission.
   */
  async monthSpentEur(clientId: string): Promise<number> {
    const from = monthStart(this.clock.now());
    const sumFor = (tx: Database) =>
      tx
        .select({ total: sql<string>`coalesce(sum(${aiCalls.costEstimateEur}), 0)` })
        .from(aiCalls)
        .where(and(eq(aiCalls.clientId, clientId), gte(aiCalls.createdAt, from)));

    const missionIds = (
      await withoutMission(this.db, (tx) =>
        tx.select({ id: missions.id }).from(missions).where(eq(missions.clientId, clientId)),
      )
    ).map((m) => m.id);

    let total = 0;
    for (const id of missionIds) {
      const [row] = await withMission(this.db, id, (tx) => sumFor(tx as unknown as Database));
      total += Number(row?.total ?? 0);
    }
    const [unscoped] = await withoutMission(this.db, (tx) => sumFor(tx as unknown as Database), {
      aiUnscoped: true,
    });
    return total + Number(unscoped?.total ?? 0);
  }
}
