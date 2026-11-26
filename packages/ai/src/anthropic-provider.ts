import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  AiConfigError,
  AiInvalidOutputError,
  AiMaxTokensError,
  AiProviderError,
  AiRefusalError,
} from './errors.js';
import { liveCallsForbidden } from './guard.js';
import type {
  AiCapabilities,
  AiProvider,
  StructuredRequest,
  StructuredResult,
  Usage,
} from './types.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './types.js';

export interface AnthropicProviderOptions {
  /** Clé déchiffrée par l'appelant ; jamais lue dans l'environnement par l'adaptateur. */
  apiKey: string;
  /** Pour pointer vers un serveur simulé en test. */
  baseURL?: string;
  /** Reprises du SDK sur 429 et 5xx (2 par défaut). */
  maxRetries?: number;
  timeoutMs?: number;
  capabilities?: Partial<AiCapabilities>;
}

type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlock = Anthropic.Messages.ContentBlockParam;

/** Adaptateur Anthropic : sortie structurée via `output_config.format` (spec 4.3). */
export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly capabilities: AiCapabilities;
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    // Garde-fou : aucun appel vers l'API réelle en CI sans AI_LIVE=1 (un serveur simulé est permis).
    if (options.baseURL === undefined && liveCallsForbidden()) {
      throw new AiConfigError('CONFIG', 'Appel réel au fournisseur interdit en CI sans AI_LIVE=1.');
    }
    this.capabilities = {
      text: true,
      documents: true,
      images: true,
      audio: false,
      ...options.capabilities,
    };
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      maxRetries: options.maxRetries ?? 2,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
  }

  /** Corps de requête (exposé pour les tests de forme) : ni prefill ni `tool_choice` forcé. */
  buildParams<T>(
    req: StructuredRequest<T>,
    maxTokens: number,
  ): Anthropic.Messages.MessageCreateParamsNonStreaming {
    if (req.model === undefined || req.model === '') {
      throw new AiConfigError(
        'CONFIG',
        `Aucun modèle configuré pour le pipeline « ${req.pipeline} ».`,
      );
    }
    const system: Anthropic.Messages.TextBlockParam[] = [
      { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
    ];
    if (req.context !== undefined && req.context !== '') {
      system.push({ type: 'text', text: req.context, cache_control: { type: 'ephemeral' } });
    }
    const messages: MessageParam[] = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    if (req.attachments !== undefined && req.attachments.length > 0) {
      const first = messages.findIndex((m) => m.role === 'user');
      if (first === -1)
        throw new AiConfigError('CONFIG', 'Pièces jointes sans message utilisateur.');
      const blocks: ContentBlock[] = req.attachments.map((a): ContentBlock => {
        const data = Buffer.from(a.data).toString('base64');
        return a.kind === 'pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
          : {
              type: 'image',
              source: {
                type: 'base64',
                media_type: a.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data,
              },
            };
      });
      const target = messages[first] as MessageParam;
      messages[first] = {
        role: 'user',
        content: [...blocks, { type: 'text', text: String(target.content) }],
      };
    }
    return {
      model: req.model,
      max_tokens: maxTokens,
      system,
      messages,
      thinking: { type: 'adaptive' },
      output_config: {
        format: zodOutputFormat(req.schema as never),
        ...(req.effort !== undefined ? { effort: req.effort } : {}),
      },
    } as Anthropic.Messages.MessageCreateParamsNonStreaming;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const initial = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    let maxTokens = initial;
    let totals: Usage = { inputTokens: 0, outputTokens: 0 };
    // `max_tokens` : une reprise avec un plafond doublé, puis une erreur.
    for (let attempt = 0; attempt < 2; attempt++) {
      const message = await this.call(this.buildParams(req, maxTokens), maxTokens);
      const usage = toUsage(message.usage);
      totals = addUsage(totals, usage);
      const text = message.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (message.stop_reason === 'refusal') throw new AiRefusalError();
      if (message.stop_reason === 'max_tokens') {
        maxTokens *= 2;
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AiInvalidOutputError(['JSON invalide'], text, totals);
      }
      const parsed = req.schema.safeParse(json);
      if (!parsed.success) {
        throw new AiInvalidOutputError(
          parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`),
          text,
          totals,
        );
      }
      return {
        data: parsed.data,
        model: message.model,
        usage: totals,
        stopReason:
          message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence'
            ? 'end'
            : 'other',
        raw: message,
      };
    }
    throw new AiMaxTokensError(maxTokens / 2, totals);
  }

  private async call(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    maxTokens: number,
  ): Promise<Anthropic.Messages.Message> {
    try {
      if (maxTokens > DEFAULT_MAX_OUTPUT_TOKENS) {
        return await this.client.messages.stream(params).finalMessage();
      }
      return await this.client.messages.create(params);
    } catch (error) {
      throw mapError(error);
    }
  }
}

function toUsage(u: Anthropic.Messages.Usage): Usage {
  const cached = u.cache_read_input_tokens ?? 0;
  return {
    inputTokens: u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  };
}

function addUsage(a: Usage, b: Usage): Usage {
  const cache = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cache > 0 ? { cacheReadTokens: cache } : {}),
  };
}

/** 400 et 404 non réessayables ; 429 limite de débit ; 5xx serveur ; le reste : réseau. */
export function mapError(error: unknown): Error {
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiProviderError('network', null, error.message, { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? null;
    const kind =
      status === 429
        ? 'rate_limit'
        : status === 404
          ? 'not_found'
          : status === 401 || status === 403
            ? 'auth'
            : status !== null && status >= 500
              ? 'server'
              : 'bad_request';
    return new AiProviderError(kind, status, error.message, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}
