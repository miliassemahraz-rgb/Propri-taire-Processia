import type { z } from 'zod';
import {
  AiBudgetExceeded,
  AiConfigError,
  AiError,
  AiInvalidOutputError,
  AiSemanticError,
  type SemanticIssue,
} from './errors.js';
import { inputHash } from './hash.js';
import { DEFAULT_PRICE_TABLE, estimateCostEur, type PriceTable } from './pricing.js';
import type { AiProvider, StructuredRequest, StructuredResult, Usage } from './types.js';

export interface PipelineContext {
  clientId: string;
  missionId?: string | null;
  userId?: string | null;
  /** Modèle par pipeline ; la clé `default` couvre les pipelines non listés (PO-12). */
  models?: Record<string, string>;
  /** Plafond mensuel en euros ; `null` ou absent : pas de plafond. */
  monthlyBudgetEur?: number | null;
}

export interface PipelineDef<I, O> {
  name: string;
  /** Change à chaque modification du prompt ou du schéma. */
  version: string;
  buildRequest(
    input: I,
    ctx: PipelineContext,
  ): Omit<StructuredRequest<O>, 'schema' | 'schemaName' | 'pipeline' | 'pipelineVersion' | 'model'>;
  outputSchema: z.ZodType<O>;
  schemaName?: string;
  semanticCheck?(output: O, input: I, ctx: PipelineContext): SemanticIssue[];
}

export interface AiCallEntry {
  missionId: string | null;
  clientId: string;
  pipeline: string;
  pipelineVersion: string;
  provider: string;
  model: string;
  inputHash: string;
  request: unknown;
  response: unknown;
  status: 'ok' | 'error';
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  costEstimateEur: number;
  durationMs: number;
  createdBy: string | null;
}

/** Écriture du journal `ai_calls` ; renvoie l'identifiant de la ligne. */
export interface AiJournal {
  record(entry: AiCallEntry): Promise<string | null>;
}

/** Consommation du mois en cours pour un client (en euros). */
export interface BudgetPort {
  monthSpentEur(clientId: string): Promise<number>;
}

export interface RunnerDeps {
  provider: AiProvider;
  journal?: AiJournal;
  budget?: BudgetPort;
  prices?: PriceTable;
  /** Appelé une fois, au franchissement de 80 % du plafond. */
  onBudgetAlert?(info: {
    clientId: string;
    spentEur: number;
    capEur: number;
  }): Promise<void> | void;
  clock?: () => number;
}

export interface PipelineRun<O> {
  output: O;
  callId: string | null;
  model: string;
  usage: Usage;
  costEstimateEur: number;
  attempts: number;
  warnings: string[];
}

export const BUDGET_ALERT_RATIO = 0.8;

function resolveModel(ctx: PipelineContext, pipeline: string, provider: AiProvider): string {
  const model = ctx.models?.[pipeline] ?? ctx.models?.['default'];
  if (model !== undefined && model !== '') return model;
  if (provider.id === 'fake') return 'fake';
  throw new AiConfigError(
    'CONFIG',
    `Aucun modèle configuré pour « ${pipeline} » (clé default absente).`,
  );
}

function sumUsage(a: Usage, b: Usage | undefined): Usage {
  if (b === undefined) return a;
  const cache = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cache > 0 ? { cacheReadTokens: cache } : {}),
  };
}

/** Requête consignée au journal : les pièces jointes sont réduites à leurs métadonnées. */
function journalRequest<T>(req: StructuredRequest<T>): unknown {
  return {
    system: req.system,
    context: req.context ?? null,
    messages: req.messages,
    schemaName: req.schemaName,
    effort: req.effort ?? null,
    maxOutputTokens: req.maxOutputTokens ?? null,
    attachments: (req.attachments ?? []).map((a) => ({
      kind: a.kind,
      mediaType: a.mediaType,
      name: a.name,
      sizeBytes: a.data.byteLength,
    })),
  };
}

/**
 * Exécuteur (spec 4.4) : budget, appel, validation zod, contrôle sémantique avec une seule
 * reprise de réparation, journal, coût estimé.
 */
export async function runPipelineDetailed<I, O>(
  def: PipelineDef<I, O>,
  input: I,
  ctx: PipelineContext,
  deps: RunnerDeps,
): Promise<PipelineRun<O>> {
  const now = deps.clock ?? Date.now;
  const cap = ctx.monthlyBudgetEur ?? null;

  // 1. Budget mensuel : au-delà, aucun appel n'est émis.
  let spentBefore = 0;
  if (cap !== null && deps.budget !== undefined) {
    spentBefore = await deps.budget.monthSpentEur(ctx.clientId);
    if (spentBefore >= cap) throw new AiBudgetExceeded(spentBefore, cap);
  }

  const model = resolveModel(ctx, def.name, deps.provider);
  const base = def.buildRequest(input, ctx);
  const request: StructuredRequest<O> = {
    ...base,
    pipeline: def.name,
    pipelineVersion: def.version,
    schema: def.outputSchema,
    schemaName: def.schemaName ?? def.name.replace(/[^A-Za-z0-9_]/g, '_'),
    model,
  };
  const hash = inputHash(request);
  const started = now();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let servedModel = model;
  let attempts = 0;
  const warnings: string[] = [];
  let result: StructuredResult<O> | undefined;
  let failure: unknown;

  const attempt = async (req: StructuredRequest<O>): Promise<StructuredResult<O>> => {
    attempts += 1;
    const r = await deps.provider.generateStructured(req);
    usage = sumUsage(usage, r.usage);
    servedModel = r.model;
    warnings.push(...(r.warnings ?? []));
    return r;
  };
  const repairRequest = (rawText: string, issues: string[]): StructuredRequest<O> => ({
    ...request,
    messages: [
      ...request.messages,
      { role: 'assistant', content: rawText },
      {
        role: 'user',
        content: `Ta réponse précédente est invalide. Corrige-la et renvoie l'objet JSON complet.\nErreurs :\n${issues.map((i) => `- ${i}`).join('\n')}`,
      },
    ],
  });

  try {
    // 2. Appel et validation du schéma ; 3. une seule reprise de réparation.
    let pending: StructuredRequest<O> = request;
    for (let round = 0; round < 2; round++) {
      let issues: string[];
      let rawText: string;
      try {
        const r = await attempt(pending);
        const semantic = def.semanticCheck?.(r.data, input, ctx) ?? [];
        if (semantic.length === 0) {
          result = r;
          break;
        }
        if (round === 1) throw new AiSemanticError(semantic);
        issues = semantic.map((i) =>
          i.path === undefined ? i.message : `${i.path} : ${i.message}`,
        );
        rawText = JSON.stringify(r.data);
      } catch (error) {
        if (!(error instanceof AiInvalidOutputError) || round === 1) throw error;
        usage = sumUsage(usage, error.usage);
        issues = error.issues;
        rawText = error.rawText;
      }
      pending = repairRequest(rawText, issues);
    }
  } catch (error) {
    failure = error;
  }

  const durationMs = Math.max(0, now() - started);
  const isFake = deps.provider.id === 'fake';
  const costEstimateEur = isFake
    ? 0
    : estimateCostEur(usage, servedModel, deps.prices ?? DEFAULT_PRICE_TABLE);

  // 4. Journal (succès comme échec : requête, réponse, jetons, coût, durée).
  let callId: string | null = null;
  if (deps.journal !== undefined) {
    callId = await deps.journal.record({
      missionId: ctx.missionId ?? null,
      clientId: ctx.clientId,
      pipeline: def.name,
      pipelineVersion: def.version,
      provider: deps.provider.id,
      model: servedModel,
      inputHash: hash,
      request: journalRequest(request),
      response:
        result === undefined
          ? null
          : { data: result.data, stopReason: result.stopReason, attempts, warnings },
      status: result === undefined ? 'error' : 'ok',
      error:
        result !== undefined
          ? null
          : failure instanceof AiError
            ? `${failure.code}: ${failure.message}`
            : String(failure instanceof Error ? failure.message : failure),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costEstimateEur,
      durationMs,
      createdBy: ctx.userId ?? null,
    });
  }

  if (result === undefined) throw failure;

  if (cap !== null && deps.onBudgetAlert !== undefined) {
    const after = spentBefore + costEstimateEur;
    if (spentBefore < cap * BUDGET_ALERT_RATIO && after >= cap * BUDGET_ALERT_RATIO) {
      await deps.onBudgetAlert({ clientId: ctx.clientId, spentEur: after, capEur: cap });
    }
  }

  return {
    output: result.data,
    callId,
    model: servedModel,
    usage,
    costEstimateEur,
    attempts,
    warnings,
  };
}

/** Variante qui ne renvoie que la sortie validée `O`. */
export async function runPipeline<I, O>(
  def: PipelineDef<I, O>,
  input: I,
  ctx: PipelineContext,
  deps: RunnerDeps,
): Promise<O> {
  return (await runPipelineDetailed(def, input, ctx, deps)).output;
}
