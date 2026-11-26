import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AiInvalidOutputError, AiMaxTokensError, AiRefusalError } from './errors.js';
import { inputHash } from './hash.js';
import type {
  AiCapabilities,
  AiProvider,
  StructuredRequest,
  StructuredResult,
  Usage,
} from './types.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './types.js';

/** Simulation d'erreur renvoyée par un scénario (chemins d'erreur testables sans réseau). */
export class FakeSimulation {
  private constructor(readonly kind: 'refusal' | 'max_tokens' | 'invalid_json') {}
  static readonly refusal = (): FakeSimulation => new FakeSimulation('refusal');
  static readonly maxTokens = (): FakeSimulation => new FakeSimulation('max_tokens');
  static readonly invalidJson = (): FakeSimulation => new FakeSimulation('invalid_json');
}

/** Fonction déterministe `requête → sortie` (ou simulation d'erreur), enregistrée par pipeline. */
export type FakeScenario = (req: StructuredRequest<unknown>) => unknown;

export interface FakeProviderOptions {
  /** Dossier `<dir>/<pipeline>/<inputHash>.json` des enregistrements exacts. */
  recordingsDir?: string;
  scenarios?: Record<string, FakeScenario>;
  capabilities?: Partial<AiCapabilities>;
}

interface Recording {
  data: unknown;
  usage?: Usage;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Valeur minimale valide pour un schéma JSON (repli générique). */
export function minimalFromJsonSchema(node: unknown): unknown {
  if (typeof node !== 'object' || node === null) return null;
  const s = node as Record<string, unknown>;
  if ('const' in s) return s['const'];
  if (Array.isArray(s['enum'])) return s['enum'][0];
  if (Array.isArray(s['anyOf'])) {
    const options = s['anyOf'] as unknown[];
    const nonNull = options.find((o) => (o as { type?: unknown }).type !== 'null');
    return minimalFromJsonSchema(nonNull ?? options[0]);
  }
  const type = Array.isArray(s['type']) ? (s['type'] as unknown[])[0] : s['type'];
  switch (type) {
    case 'object': {
      const props = (s['properties'] ?? {}) as Record<string, unknown>;
      const required = (s['required'] ?? []) as string[];
      return Object.fromEntries(required.map((k) => [k, minimalFromJsonSchema(props[k])]));
    }
    case 'array': {
      const min = typeof s['minItems'] === 'number' ? s['minItems'] : 0;
      return Array.from({ length: min }, () => minimalFromJsonSchema(s['items']));
    }
    case 'string':
      return 'x'.repeat(typeof s['minLength'] === 'number' ? s['minLength'] : 0);
    case 'integer':
    case 'number':
      return typeof s['minimum'] === 'number' ? s['minimum'] : 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`);
}

/**
 * Fournisseur factice déterministe (ADR 0006). Ordre de réponse : enregistrement exact,
 * scénario scripté, repli générique. Toute sortie passe par le schéma de la requête.
 */
export class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly capabilities: AiCapabilities;
  private readonly scenarios: Map<string, FakeScenario>;

  constructor(private readonly options: FakeProviderOptions = {}) {
    this.capabilities = {
      text: true,
      documents: true,
      images: true,
      audio: false,
      ...options.capabilities,
    };
    this.scenarios = new Map(Object.entries(options.scenarios ?? {}));
  }

  registerScenario(pipeline: string, scenario: FakeScenario): void {
    this.scenarios.set(pipeline, scenario);
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const hash = inputHash(req);
    const warnings: string[] = [];
    let candidate: unknown;
    let source: 'recording' | 'scenario' | 'generic';

    const recorded = this.readRecording(req.pipeline, hash);
    const scenario = this.scenarios.get(req.pipeline);
    if (recorded !== undefined) {
      candidate = recorded.data;
      source = 'recording';
    } else if (scenario !== undefined) {
      candidate = scenario(req as StructuredRequest<unknown>);
      source = 'scenario';
    } else {
      candidate = this.generic(req.schema);
      source = 'generic';
      warnings.push(
        `Repli générique du fournisseur factice pour « ${req.pipeline} » : aucun enregistrement ni scénario.`,
      );
    }

    const maxTokens = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (candidate instanceof FakeSimulation) {
      if (candidate.kind === 'refusal') throw new AiRefusalError();
      if (candidate.kind === 'max_tokens') throw new AiMaxTokensError(maxTokens);
      throw new AiInvalidOutputError(['JSON invalide'], '{"truncated":', this.usage(req, '{'));
    }

    const rawText = JSON.stringify(candidate) ?? 'null';
    const parsed = req.schema.safeParse(candidate);
    const usage = this.usage(req, rawText);
    if (!parsed.success) throw new AiInvalidOutputError(formatIssues(parsed.error), rawText, usage);
    return {
      data: parsed.data,
      model: 'fake',
      usage,
      stopReason: 'end',
      raw: { source, inputHash: hash },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private generic(schema: z.ZodType<unknown>): unknown {
    try {
      return minimalFromJsonSchema(z.toJSONSchema(schema, { unrepresentable: 'any' }));
    } catch {
      return null;
    }
  }

  private usage(req: StructuredRequest<unknown>, output: string): Usage {
    const input =
      req.system.length +
      (req.context?.length ?? 0) +
      req.messages.reduce((n, m) => n + m.content.length, 0);
    return { inputTokens: approxTokens('x'.repeat(input)), outputTokens: approxTokens(output) };
  }

  private readRecording(pipeline: string, hash: string): Recording | undefined {
    const dir = this.options.recordingsDir;
    if (dir === undefined) return undefined;
    const file = join(dir, pipeline, `${hash}.json`);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as Recording;
  }
}

/**
 * Mode enregistrement (`AI_RECORD=1`, vraie clé) : écrit chaque réponse réelle comme
 * enregistrement exact, rejouable ensuite par `FakeProvider` sans coût.
 */
export class RecordingProvider implements AiProvider {
  constructor(
    private readonly inner: AiProvider,
    private readonly recordingsDir: string,
  ) {}

  get id(): string {
    return this.inner.id;
  }
  get capabilities(): AiCapabilities {
    return this.inner.capabilities;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const result = await this.inner.generateStructured(req);
    const dir = join(this.recordingsDir, req.pipeline);
    mkdirSync(dir, { recursive: true });
    const recording: Recording & { pipeline: string; schemaName: string } = {
      pipeline: req.pipeline,
      schemaName: req.schemaName,
      data: result.data,
      usage: result.usage,
    };
    writeFileSync(join(dir, `${inputHash(req)}.json`), `${JSON.stringify(recording, null, 2)}\n`);
    return result;
  }
}
