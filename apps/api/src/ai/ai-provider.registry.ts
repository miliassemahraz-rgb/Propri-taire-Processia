import { Inject, Injectable } from '@nestjs/common';
import {
  AiConfigError,
  AnthropicProvider,
  FakeProvider,
  RecordingProvider,
  type AiProvider,
  type FakeScenario,
} from '@processia/ai';
import type { Env } from '@processia/config/env';
import { DEFAULT_MONTHLY_BUDGET_EUR } from '@processia/contracts';
import { decryptSecret } from '../auth/crypto.js';
import { AiConfigService, KEY_PURPOSE } from '../clients/ai-config.service.js';
import { ENV } from '../env.js';

export interface ResolvedAiProvider {
  provider: AiProvider;
  /** Vrai quand les réponses sont simulées : l'interface affiche le bandeau « IA simulée ». */
  simulated: boolean;
  /** Modèle par pipeline (`default` pour les pipelines non listés), tel que configuré. */
  models: Record<string, string>;
  monthlyBudgetEur: number | null;
}

/** Résolution du fournisseur IA d'un client à partir de `ai_provider_configs` (spec 4.1). */
@Injectable()
export class AiProviderRegistry {
  /** Instance unique : les scénarios enregistrés par les WP aval y sont partagés. */
  private readonly fake: FakeProvider;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AiConfigService) private readonly configs: AiConfigService,
  ) {
    this.fake = new FakeProvider(
      this.env.AI_RECORDINGS_DIR === undefined ? {} : { recordingsDir: this.env.AI_RECORDINGS_DIR },
    );
  }

  /** Scénario déterministe du fournisseur factice pour un pipeline (WP-12, WP-14, WP-20...). */
  registerFakeScenario(pipeline: string, scenario: FakeScenario): void {
    this.fake.registerScenario(pipeline, scenario);
  }

  async forClient(clientId: string): Promise<ResolvedAiProvider> {
    const row = await this.configs.find(clientId);
    const models = row?.models ?? {};
    const budget = row?.monthlyBudgetEur;
    const monthlyBudgetEur =
      budget === undefined || budget === null ? DEFAULT_MONTHLY_BUDGET_EUR : Number(budget);
    const simulated: ResolvedAiProvider = {
      provider: this.fake,
      simulated: true,
      models,
      monthlyBudgetEur,
    };

    if (this.env.AI_PROVIDER_OVERRIDE === 'fake') return simulated;
    // Sans configuration active ni clé : fournisseur factice, toujours.
    if (row === null || !row.active || row.provider === 'fake' || row.apiKeyEnc === null) {
      return simulated;
    }
    if (row.provider !== 'anthropic') {
      throw new AiConfigError('CONFIG', `Fournisseur IA inconnu : ${row.provider}.`);
    }
    // Pas d'appel réel tant que la politique de données n'est pas acceptée (CDC 6.7).
    if (row.policyAcceptedAt === null) {
      throw new AiConfigError(
        'POLICY_NOT_ACCEPTED',
        'La politique de données du fournisseur IA n’est pas acceptée.',
      );
    }
    const apiKey = decryptSecret(row.apiKeyEnc, this.env.MASTER_KEY, KEY_PURPOSE);
    const real: AiProvider = new AnthropicProvider({
      apiKey,
      capabilities: { ...row.capabilities, images: row.capabilities.documents },
      ...(this.env.AI_BASE_URL === undefined ? {} : { baseURL: this.env.AI_BASE_URL }),
    });
    const provider =
      this.env.AI_RECORD === '1' && this.env.AI_RECORDINGS_DIR !== undefined
        ? new RecordingProvider(real, this.env.AI_RECORDINGS_DIR)
        : real;
    return { provider, simulated: false, models, monthlyBudgetEur };
  }
}
