import { z } from 'zod';
import type { Usage } from './types.js';

/** Tarif en euros par million de jetons. */
export interface Rate {
  inputPerMTokEur: number;
  outputPerMTokEur: number;
  cacheReadPerMTokEur?: number;
}

export interface PriceTable {
  /** Tarif des modèles non listés. */
  default: Rate;
  /** Tarif par identifiant de modèle (fourni par la configuration, jamais écrit en dur). */
  models?: Record<string, Rate>;
}

const rateSchema = z.object({
  inputPerMTokEur: z.number().nonnegative(),
  outputPerMTokEur: z.number().nonnegative(),
  cacheReadPerMTokEur: z.number().nonnegative().optional(),
});
const priceTableSchema = z.object({
  default: rateSchema,
  models: z.record(z.string(), rateSchema).optional(),
});

/** Tarif prudent par défaut (estimation) ; la table réelle se configure via `AI_PRICE_TABLE`. */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  default: { inputPerMTokEur: 3, outputPerMTokEur: 15, cacheReadPerMTokEur: 0.3 },
};

/** Lit une table de prix JSON (variable d'environnement) ; valeur absente : table par défaut. */
export function parsePriceTable(json: string | undefined): PriceTable {
  if (json === undefined || json.trim() === '') return DEFAULT_PRICE_TABLE;
  return priceTableSchema.parse(JSON.parse(json));
}

export function estimateCostEur(usage: Usage, model: string, table: PriceTable): number {
  const rate = table.models?.[model] ?? table.default;
  const cached = usage.cacheReadTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - cached);
  const cost =
    (fresh * rate.inputPerMTokEur +
      cached * (rate.cacheReadPerMTokEur ?? rate.inputPerMTokEur) +
      usage.outputTokens * rate.outputPerMTokEur) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
