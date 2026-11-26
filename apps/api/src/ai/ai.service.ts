import { Inject, Injectable } from '@nestjs/common';
import {
  parsePriceTable,
  runPipelineDetailed,
  type PipelineDef,
  type PipelineRun,
  type PriceTable,
} from '@processia/ai';
import type { Env } from '@processia/config/env';
import { missions, withoutMission, type Database } from '@processia/db';
import { eq } from 'drizzle-orm';
import { AuditService } from '../auth/services.js';
import { DB } from '../db/db.module.js';
import { ENV } from '../env.js';
import { AiCallsService } from './ai-calls.service.js';
import { AiProviderRegistry } from './ai-provider.registry.js';

export interface RunAiOptions {
  /** Facultatif si `missionId` est fourni : le client est alors déduit de la mission. */
  clientId?: string;
  missionId?: string | null;
  userId?: string | null;
}

/** Point d'entrée des WP aval : exécute un pipeline avec le fournisseur, le budget et le journal du client. */
@Injectable()
export class AiService {
  private readonly prices: PriceTable;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) env: Env,
    @Inject(AiProviderRegistry) private readonly registry: AiProviderRegistry,
    @Inject(AiCallsService) private readonly calls: AiCallsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.prices = parsePriceTable(env.AI_PRICE_TABLE);
  }

  async run<I, O>(
    def: PipelineDef<I, O>,
    input: I,
    options: RunAiOptions,
  ): Promise<PipelineRun<O>> {
    const clientId = await this.resolveClient(options);
    const resolved = await this.registry.forClient(clientId);
    return runPipelineDetailed(
      def,
      input,
      {
        clientId,
        missionId: options.missionId ?? null,
        userId: options.userId ?? null,
        models: resolved.models,
        monthlyBudgetEur: resolved.monthlyBudgetEur,
      },
      {
        provider: resolved.provider,
        journal: this.calls,
        budget: this.calls,
        prices: this.prices,
        // L'administrateur est alerté à 80 % du plafond : trace d'audit consultable.
        onBudgetAlert: async ({ clientId: id, spentEur, capEur }) => {
          await this.audit.record({
            actorId: null,
            action: 'ai_budget.alert_80',
            target: `client:${id}`,
            payload: { spentEur, capEur },
          });
        },
      },
    );
  }

  /** Indique si les réponses du client sont simulées (bandeau « IA simulée »). */
  async isSimulated(clientId: string): Promise<boolean> {
    return (await this.registry.forClient(clientId)).simulated;
  }

  private async resolveClient(options: RunAiOptions): Promise<string> {
    if (options.clientId !== undefined) return options.clientId;
    if (options.missionId === undefined || options.missionId === null) {
      throw new Error('AiService.run : clientId ou missionId requis.');
    }
    const [row] = await withoutMission(this.db, (tx) =>
      tx
        .select({ clientId: missions.clientId })
        .from(missions)
        .where(eq(missions.id, options.missionId as string))
        .limit(1),
    );
    if (row === undefined) throw new Error('AiService.run : mission introuvable.');
    return row.clientId;
  }
}
