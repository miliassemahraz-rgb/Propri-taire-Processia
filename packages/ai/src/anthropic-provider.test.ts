import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from './anthropic-provider.js';
import {
  AiConfigError,
  AiInvalidOutputError,
  AiMaxTokensError,
  AiProviderError,
  AiRefusalError,
} from './errors.js';
import { assertNoRealKeyInCi, liveCallsForbidden } from './guard.js';
import type { StructuredRequest } from './types.js';

// Serveur HTTP simulé : aucun appel réseau réel (acceptation 4 et 5). Les identifiants de modèle
// ci-dessous sont des valeurs de test arbitraires, pas des modèles réels.

interface Seen {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}
type Handler = (seen: Seen, res: ServerResponse, n: number) => void;

let server: Server;
let baseURL: string;
let seen: Seen[];
let handler: Handler;

beforeEach(async () => {
  seen = [];
  handler = () => undefined;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Seen = {
        url: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
      };
      seen.push(entry);
      handler(entry, res, seen.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function reply(
  res: ServerResponse,
  body: { text?: string; stop_reason?: string; out?: number } = {},
): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'served-model',
      content: [{ type: 'text', text: body.text ?? '{"answer":"ok"}' }],
      stop_reason: body.stop_reason ?? 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: body.out ?? 5 },
    }),
  );
}

const schema = z.object({ answer: z.string() });
function request(over: Partial<StructuredRequest<{ answer: string }>> = {}): StructuredRequest<{
  answer: string;
}> {
  return {
    pipeline: 'p.test',
    pipelineVersion: '1',
    system: 'Système stable',
    messages: [{ role: 'user', content: 'Bonjour' }],
    schema,
    schemaName: 'Answer',
    model: 'configured-model',
    effort: 'low',
    ...over,
  };
}
const provider = (): AnthropicProvider =>
  new AnthropicProvider({ apiKey: 'test-key', baseURL, maxRetries: 2 });

describe('WP-09 acceptation 4 : adaptateur Anthropic contre un serveur HTTP simulé', () => {
  it('forme de la requête : output_config.format, modèle configuré, ni prefill ni tool_choice', async () => {
    handler = (_s, res) => reply(res);
    const result = await provider().generateStructured(request());
    expect(result.data).toEqual({ answer: 'ok' });
    expect(result.model).toBe('served-model');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.stopReason).toBe('end');
    const call = seen[0] as Seen;
    expect(call.url).toBe('/v1/messages');
    expect(JSON.stringify(call.headers)).toContain('test-key');
    const body = call.body;
    expect(body['model']).toBe('configured-model');
    expect(body['max_tokens']).toBe(16000);
    const outputConfig = body['output_config'] as {
      format: { type: string; schema: unknown };
      effort: string;
    };
    expect(outputConfig.format.type).toBe('json_schema');
    expect(outputConfig.format.schema).toMatchObject({
      type: 'object',
      properties: { answer: {} },
    });
    expect(outputConfig.effort).toBe('low');
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('tools');
    const messages = body['messages'] as { role: string }[];
    expect(messages.at(-1)?.role).toBe('user'); // pas de préremplissage de la réponse
    const system = body['system'] as { cache_control?: unknown }[];
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('contexte stable en second bloc système mis en cache ; pièces jointes en blocs document et image', async () => {
    handler = (_s, res) => reply(res);
    await provider().generateStructured(
      request({
        context: 'Résumé du modèle',
        attachments: [
          {
            kind: 'pdf',
            mediaType: 'application/pdf',
            data: new Uint8Array([1, 2]),
            name: 'a.pdf',
          },
          { kind: 'image', mediaType: 'image/png', data: new Uint8Array([3]), name: 'b.png' },
        ],
      }),
    );
    const body = (seen[0] as Seen).body;
    const system = body['system'] as { text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(2);
    expect(system[1]).toMatchObject({
      text: 'Résumé du modèle',
      cache_control: { type: 'ephemeral' },
    });
    const content = (body['messages'] as { content: { type: string }[] }[])[0]?.content ?? [];
    expect(content.map((b) => b.type)).toEqual(['document', 'image', 'text']);
  });

  it('refus (stop_reason refusal) : AiRefusalError', async () => {
    handler = (_s, res) => reply(res, { text: '', stop_reason: 'refusal' });
    await expect(provider().generateStructured(request())).rejects.toBeInstanceOf(AiRefusalError);
  });

  it('max_tokens : une reprise avec un plafond doublé', async () => {
    handler = (_s, res, n) =>
      n === 1 ? reply(res, { text: '{"answ', stop_reason: 'max_tokens' }) : reply(res);
    const result = await provider().generateStructured(request({ maxOutputTokens: 1000 }));
    expect(result.data).toEqual({ answer: 'ok' });
    expect(seen.map((s) => s.body['max_tokens'])).toEqual([1000, 2000]);
    expect(result.usage.outputTokens).toBe(10);
  });

  it('max_tokens deux fois : AiMaxTokensError', async () => {
    handler = (_s, res) => reply(res, { text: '{"a', stop_reason: 'max_tokens' });
    await expect(
      provider().generateStructured(request({ maxOutputTokens: 1000 })),
    ).rejects.toBeInstanceOf(AiMaxTokensError);
    expect(seen).toHaveLength(2);
  });

  it('429 : le SDK reprend la requête puis la réponse est servie', async () => {
    handler = (_s, res, n) => {
      if (n === 1) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after-ms': '1',
        });
        res.end(
          JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }),
        );
      } else reply(res);
    };
    const result = await provider().generateStructured(request());
    expect(result.data).toEqual({ answer: 'ok' });
    expect(seen).toHaveLength(2);
  });

  it('429 persistant : AiProviderError rate_limit réessayable ; 400 non réessayé', async () => {
    handler = (_s, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': '1' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'x' } }));
    };
    const p = new AnthropicProvider({ apiKey: 'k', baseURL, maxRetries: 1 });
    const err = await p.generateStructured(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).kind).toBe('rate_limit');
    expect((err as AiProviderError).retryable).toBe(true);
    expect(seen).toHaveLength(2);

    seen = [];
    handler = (_s, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }),
      );
    };
    const bad = await provider()
      .generateStructured(request())
      .catch((e: unknown) => e);
    expect((bad as AiProviderError).kind).toBe('bad_request');
    expect((bad as AiProviderError).retryable).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('JSON hors schéma : AiInvalidOutputError avec le texte brut', async () => {
    handler = (_s, res) => reply(res, { text: '{"answer": 3}' });
    const err = await provider()
      .generateStructured(request())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiInvalidOutputError);
    expect((err as AiInvalidOutputError).rawText).toBe('{"answer": 3}');
    handler = (_s, res) => reply(res, { text: 'pas du json' });
    await expect(provider().generateStructured(request())).rejects.toBeInstanceOf(
      AiInvalidOutputError,
    );
  });

  it('sans modèle configuré : erreur de configuration, aucun appel', async () => {
    await expect(provider().generateStructured(request({ model: '' }))).rejects.toBeInstanceOf(
      AiConfigError,
    );
    expect(seen).toHaveLength(0);
  });
});

describe('WP-09 acceptation 5 : garde-fou contre les appels réels en CI', () => {
  it('sans baseURL, en CI sans AI_LIVE=1, la construction est refusée', () => {
    const before = { CI: process.env['CI'], AI_LIVE: process.env['AI_LIVE'] };
    process.env['CI'] = 'true';
    delete process.env['AI_LIVE'];
    try {
      expect(() => new AnthropicProvider({ apiKey: 'k' })).toThrow(AiConfigError);
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('ANTHROPIC_API_KEY définie en CI sans AI_LIVE=1 : échec ; avec AI_LIVE=1 ou hors CI : toléré', () => {
    expect(liveCallsForbidden({ CI: 'true' })).toBe(true);
    expect(() => assertNoRealKeyInCi({ CI: 'true', ANTHROPIC_API_KEY: 'k' })).toThrow(
      AiConfigError,
    );
    expect(() =>
      assertNoRealKeyInCi({ CI: 'true', AI_LIVE: '1', ANTHROPIC_API_KEY: 'k' }),
    ).not.toThrow();
    expect(() => assertNoRealKeyInCi({ ANTHROPIC_API_KEY: 'k' })).not.toThrow();
  });

  it("l'environnement de ce test d'unité ne porte pas de clé réelle en CI", () => {
    expect(() => assertNoRealKeyInCi()).not.toThrow();
  });
});

describe('test réel optionnel', () => {
  const key = process.env['ANTHROPIC_API_KEY'];
  const model = process.env['AI_LIVE_MODEL'];
  it.runIf(process.env['AI_LIVE'] === '1' && key !== undefined && model !== undefined)(
    'appel minimal réel (AI_LIVE=1, ANTHROPIC_API_KEY, AI_LIVE_MODEL)',
    async () => {
      const p = new AnthropicProvider({ apiKey: key as string });
      const r = await p.generateStructured(
        request({ model: model as string, maxOutputTokens: 500 }),
      );
      expect(typeof r.data.answer).toBe('string');
    },
    60_000,
  );
});
