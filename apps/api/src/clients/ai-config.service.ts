import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import {
  capabilityWarnings,
  DEFAULT_MONTHLY_BUDGET_EUR,
  type AiCapabilitiesDto,
  type AiConfigDto,
  type DataPolicyDto,
  type UpsertAiConfigRequest,
} from '@processia/contracts';
import { aiProviderConfigs, clients, type Database } from '@processia/db';
import { t } from '@processia/i18n';
import { desc, eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '../auth/crypto.js';
import { AuthError } from '../auth/errors.js';
import { AuditService, CLOCK, type Clock } from '../auth/services.js';
import { DB } from '../db/db.module.js';
import { ENV } from '../env.js';

type ConfigRow = typeof aiProviderConfigs.$inferSelect;
type Provider = UpsertAiConfigRequest['provider'];

/** Séparation de domaine : la clé dérivée de `MASTER_KEY` ne sert qu'aux clés API des fournisseurs. */
export const KEY_PURPOSE = 'processia-ai-api-key-v1';

/** Capacités déclarées par défaut ; l'administrateur peut les corriger (le contrôle s'y fonde). */
const DEFAULT_CAPABILITIES: Record<Provider, AiCapabilitiesDto> = {
  fake: { text: true, documents: true, audio: false },
  anthropic: { text: true, documents: true, audio: false },
};

/** Politique de données du fournisseur (CDC 6.7) ; `null` pour le fournisseur factice (aucun envoi). */
export function dataPolicyFor(provider: Provider): string | null {
  return provider === 'anthropic' ? t('aiProviders.dataPolicy.anthropic') : null;
}

export function maskApiKey(plain: string): string {
  return plain.length >= 8 ? `••••••••${plain.slice(-4)}` : '••••••••';
}

/** Configuration du fournisseur IA par client : accès administrateur (`ai_providers.manage`). */
@Injectable()
export class AiConfigService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  dataPolicy(provider: Provider): DataPolicyDto {
    return { provider, text: dataPolicyFor(provider) };
  }

  /** Configuration active ou la plus récente du client, `null` s'il n'en existe aucune. */
  async find(clientId: string): Promise<ConfigRow | null> {
    const [row] = await this.db
      .select()
      .from(aiProviderConfigs)
      .where(eq(aiProviderConfigs.clientId, clientId))
      .orderBy(desc(aiProviderConfigs.createdAt))
      .limit(1);
    return row ?? null;
  }

  async get(clientId: string): Promise<AiConfigDto> {
    const row = await this.find(clientId);
    if (row === null) throw new AuthError('NOT_FOUND');
    return this.toDto(row);
  }

  async upsert(
    clientId: string,
    input: UpsertAiConfigRequest,
    actorId: string,
    ip: string | null,
  ): Promise<AiConfigDto> {
    const [client] = await this.db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (client === undefined) throw new AuthError('NOT_FOUND');
    const existing = await this.find(clientId);

    const policyText = dataPolicyFor(input.provider);
    const sameProvider = existing?.provider === input.provider;
    // Acceptation (PO-33) : explicite dans cette requête, ou déjà enregistrée pour ce fournisseur.
    // Elle n'est exigée qu'une fois : un changement ultérieur du texte de la politique ne demande
    // pas de nouvelle acceptation, et le texte accepté reste celui enregistré.
    let acceptedBy: string | null = null;
    let acceptedAt: Date | null = null;
    let acceptedText: string | null = policyText;
    if (policyText !== null) {
      if (input.acceptDataPolicy === true) {
        acceptedBy = actorId;
        acceptedAt = this.clock.now();
      } else if (sameProvider && existing.policyAcceptedAt !== null) {
        acceptedBy = existing.policyAcceptedBy;
        acceptedAt = existing.policyAcceptedAt;
        acceptedText = existing.dataPolicyText ?? policyText;
      } else {
        throw new AuthError('POLICY_NOT_ACCEPTED');
      }
    }

    let apiKeyEnc = existing?.apiKeyEnc ?? null;
    if (input.apiKey !== undefined) {
      apiKeyEnc =
        input.apiKey === '' ? null : encryptSecret(input.apiKey, this.env.MASTER_KEY, KEY_PURPOSE);
    }

    const values = {
      clientId,
      provider: input.provider,
      models: input.models ?? existing?.models ?? {},
      apiKeyEnc,
      capabilities:
        input.capabilities ??
        (sameProvider ? existing.capabilities : DEFAULT_CAPABILITIES[input.provider]),
      dataPolicyText: acceptedText,
      policyAcceptedBy: acceptedBy,
      policyAcceptedAt: acceptedAt,
      monthlyBudgetEur: String(
        input.monthlyBudgetEur ?? existing?.monthlyBudgetEur ?? DEFAULT_MONTHLY_BUDGET_EUR,
      ),
      active: input.active ?? existing?.active ?? true,
    };
    const [row] =
      existing === null
        ? await this.db.insert(aiProviderConfigs).values(values).returning()
        : await this.db
            .update(aiProviderConfigs)
            .set(values)
            .where(eq(aiProviderConfigs.id, existing.id))
            .returning();
    if (row === undefined) throw new Error('Configuration IA non enregistrée.');
    await this.audit.record({
      actorId,
      action: existing === null ? 'ai_config.created' : 'ai_config.updated',
      target: `client:${clientId}`,
      // Jamais la clé : seulement l'indication qu'elle a changé.
      payload: {
        provider: input.provider,
        apiKeyChanged: input.apiKey !== undefined,
        policyAccepted: input.acceptDataPolicy === true,
      },
      ip,
    });
    return this.toDto(row);
  }

  toDto(row: ConfigRow): AiConfigDto {
    const plain =
      row.apiKeyEnc === null
        ? null
        : decryptSecret(row.apiKeyEnc, this.env.MASTER_KEY, KEY_PURPOSE);
    return {
      id: row.id,
      clientId: row.clientId,
      provider: row.provider as Provider,
      models: row.models,
      apiKey: { configured: plain !== null, masked: plain === null ? null : maskApiKey(plain) },
      capabilities: row.capabilities,
      dataPolicyText: row.dataPolicyText,
      policyAcceptedBy: row.policyAcceptedBy,
      policyAcceptedAt: row.policyAcceptedAt?.toISOString() ?? null,
      monthlyBudgetEur: row.monthlyBudgetEur === null ? null : Number(row.monthlyBudgetEur),
      active: row.active,
      warnings: capabilityWarnings(row.capabilities),
    };
  }
}
