import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiBudgetExceeded,
  AiConfigError,
  AiInvalidOutputError,
  AiRefusalError,
  AiSemanticError,
} from './errors.js';
import { FakeProvider, FakeSimulation, RecordingProvider } from './fake-provider.js';
import { inputHash } from './hash.js';
import { demoSummaryPipeline } from './pipelines/demo.js';
import { estimateCostEur, parsePriceTable } from './pricing.js';
import { loadPrompt, renderPrompt } from './prompts.js';
import {
  runPipeline,
  runPipelineDetailed,
  type AiCallEntry,
  type AiJournal,
  type PipelineDef,
} from './runner.js';

class MemoryJournal implements AiJournal {
  readonly entries: AiCallEntry[] = [];
  async record(entry: AiCallEntry): Promise<string | null> {
    this.entries.push(entry);
    return `call-${this.entries.length}`;
  }
}

const ctx = { clientId: 'client-1', missionId: null, userId: null };
const valid = { summary: 'Un résumé.', keywords: ['a', 'b'] };

describe('WP-09 acceptation 1 : pipeline de démonstration avec le fournisseur factice', () => {
  it('la sortie est validée et journalisée', async () => {
    const journal = new MemoryJournal();
    const provider = new FakeProvider({ scenarios: { 'demo.summary': () => valid } });
    const run = await runPipelineDetailed(demoSummaryPipeline, { text: 'Texte du client.' }, ctx, {
      provider,
      journal,
    });
    expect(run.output).toEqual(valid);
    expect(run.callId).toBe('call-1');
    expect(journal.entries).toHaveLength(1);
    const [entry] = journal.entries;
    expect(entry).toMatchObject({
      pipeline: 'demo.summary',
      pipelineVersion: '1',
      provider: 'fake',
      status: 'ok',
      error: null,
      costEstimateEur: 0,
      clientId: 'client-1',
    });
    expect(entry?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry?.outputTokens).toBeGreaterThan(0);
    expect(JSON.stringify(entry?.request)).toContain('Texte du client.');
    expect((entry?.response as { data: unknown }).data).toEqual(valid);
  });

  it('repli générique : sortie minimale valide et avertissement dans le journal', async () => {
    const journal = new MemoryJournal();
    const run = await runPipelineDetailed(demoSummaryPipeline, { text: 'x' }, ctx, {
      provider: new FakeProvider(),
      journal,
    });
    expect(demoSummaryPipeline.outputSchema.safeParse(run.output).success).toBe(true);
    expect(run.warnings[0]).toContain('Repli générique');
    expect((journal.entries[0]?.response as { warnings: string[] }).warnings).toHaveLength(1);
  });

  it('un enregistrement exact prime sur le scénario ; le mode enregistrement le produit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-rec-'));
    const source = new FakeProvider({ scenarios: { 'demo.summary': () => valid } });
    const recorder = new RecordingProvider(source, dir);
    await runPipeline(demoSummaryPipeline, { text: 'rejeu' }, ctx, { provider: recorder });
    expect(readdirSync(join(dir, 'demo.summary'))).toHaveLength(1);
    const replay = new FakeProvider({
      recordingsDir: dir,
      scenarios: { 'demo.summary': () => ({ summary: 'autre', keywords: [] }) },
    });
    const out = await runPipeline(demoSummaryPipeline, { text: 'rejeu' }, ctx, {
      provider: replay,
    });
    expect(out).toEqual(valid);
    const file = readdirSync(join(dir, 'demo.summary'))[0] as string;
    expect(JSON.parse(readFileSync(join(dir, 'demo.summary', file), 'utf8')).data).toEqual(valid);
  });

  it("l'empreinte est stable et sensible au contenu", () => {
    const base = {
      pipeline: 'p',
      system: 'S',
      messages: [{ role: 'user' as const, content: 'a\r\n' }],
      schemaName: 'N',
    };
    expect(inputHash(base)).toBe(
      inputHash({ ...base, messages: [{ role: 'user', content: 'a' }] }),
    );
    expect(inputHash(base)).not.toBe(inputHash({ ...base, schemaName: 'M' }));
  });
});

describe('WP-09 acceptation 2 : JSON hors schéma, une reprise puis l’erreur typée', () => {
  it('reprise de réparation réussie : deux appels, erreurs renvoyées au modèle', async () => {
    const seen: string[] = [];
    const provider = new FakeProvider({
      scenarios: {
        'demo.summary': (req) => {
          seen.push(req.messages.map((m) => m.content).join('|'));
          return req.messages.length === 1 ? { summary: 12 } : valid;
        },
      },
    });
    const journal = new MemoryJournal();
    const run = await runPipelineDetailed(demoSummaryPipeline, { text: 't' }, ctx, {
      provider,
      journal,
    });
    expect(run.attempts).toBe(2);
    expect(seen[1]).toContain('Erreurs');
    expect(seen[1]).toContain('summary');
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]?.status).toBe('ok');
  });

  it('deux échecs : AiInvalidOutputError, journalisée en erreur, pas de troisième appel', async () => {
    let calls = 0;
    const provider = new FakeProvider({
      scenarios: {
        'demo.summary': () => {
          calls += 1;
          return { summary: 12 };
        },
      },
    });
    const journal = new MemoryJournal();
    await expect(
      runPipeline(demoSummaryPipeline, { text: 't' }, ctx, { provider, journal }),
    ).rejects.toBeInstanceOf(AiInvalidOutputError);
    expect(calls).toBe(2);
    expect(journal.entries[0]).toMatchObject({ status: 'error' });
    expect(journal.entries[0]?.error).toContain('INVALID_OUTPUT');
  });

  it('JSON invalide simulé', async () => {
    const provider = new FakeProvider({
      scenarios: { 'demo.summary': () => FakeSimulation.invalidJson() },
    });
    await expect(
      runPipeline(demoSummaryPipeline, { text: 't' }, ctx, { provider }),
    ).rejects.toBeInstanceOf(AiInvalidOutputError);
  });

  it('refus simulé : AiRefusalError, journalisée', async () => {
    const provider = new FakeProvider({
      scenarios: { 'demo.summary': () => FakeSimulation.refusal() },
    });
    const journal = new MemoryJournal();
    await expect(
      runPipeline(demoSummaryPipeline, { text: 't' }, ctx, { provider, journal }),
    ).rejects.toBeInstanceOf(AiRefusalError);
    expect(journal.entries[0]?.error).toContain('REFUSAL');
  });

  it('contrôle sémantique : une reprise, puis AiSemanticError', async () => {
    const def: PipelineDef<{ id: string }, { ref: string }> = {
      name: 'semantic.demo',
      version: '1',
      outputSchema: z.object({ ref: z.string() }),
      buildRequest: () => ({ system: 's', messages: [{ role: 'user', content: 'u' }] }),
      semanticCheck: (out, input) =>
        out.ref === input.id ? [] : [{ path: 'ref', message: 'identifiant inconnu' }],
    };
    const ok = new FakeProvider({
      scenarios: { 'semantic.demo': (req) => ({ ref: req.messages.length === 1 ? 'zzz' : 'a' }) },
    });
    expect((await runPipelineDetailed(def, { id: 'a' }, ctx, { provider: ok })).attempts).toBe(2);
    const ko = new FakeProvider({ scenarios: { 'semantic.demo': () => ({ ref: 'zzz' }) } });
    await expect(runPipeline(def, { id: 'a' }, ctx, { provider: ko })).rejects.toBeInstanceOf(
      AiSemanticError,
    );
  });
});

describe('WP-09 acceptation 3 : budget dépassé', () => {
  const provider = new FakeProvider({ scenarios: { 'demo.summary': () => valid } });

  it("l'appel est bloqué (AiBudgetExceeded) sans appeler le fournisseur ni journaliser", async () => {
    let called = false;
    const spy = {
      id: 'fake',
      capabilities: provider.capabilities,
      generateStructured: (...a: Parameters<typeof provider.generateStructured>) => {
        called = true;
        return provider.generateStructured(...a);
      },
    };
    const journal = new MemoryJournal();
    const budget = { monthSpentEur: async () => 150 };
    await expect(
      runPipeline(
        demoSummaryPipeline,
        { text: 't' },
        { ...ctx, monthlyBudgetEur: 150 },
        {
          provider: spy as never,
          journal,
          budget,
        },
      ),
    ).rejects.toBeInstanceOf(AiBudgetExceeded);
    expect(called).toBe(false);
    expect(journal.entries).toHaveLength(0);
  });

  it('sous le plafond : passe ; alerte au franchissement de 80 %', async () => {
    const alerts: number[] = [];
    const prices = parsePriceTable(
      JSON.stringify({ default: { inputPerMTokEur: 1_000_000, outputPerMTokEur: 1_000_000 } }),
    );
    const real = {
      id: 'other',
      capabilities: provider.capabilities,
      generateStructured: async () => ({
        data: valid,
        model: 'm',
        usage: { inputTokens: 10, outputTokens: 10 },
        stopReason: 'end' as const,
        raw: null,
      }),
    };
    const run = await runPipelineDetailed(
      demoSummaryPipeline,
      { text: 't' },
      { ...ctx, models: { default: 'm' }, monthlyBudgetEur: 100 },
      {
        provider: real as never,
        budget: { monthSpentEur: async () => 70 },
        prices,
        onBudgetAlert: ({ spentEur }) => void alerts.push(spentEur),
      },
    );
    expect(run.costEstimateEur).toBe(20);
    expect(alerts).toEqual([90]);
  });
});

describe('modèle, prix, prompts', () => {
  it('modèle par pipeline puis clé default ; absent hors factice : erreur de configuration', async () => {
    const seen: (string | undefined)[] = [];
    const real = {
      id: 'other',
      capabilities: { text: true, documents: true, images: true, audio: false },
      generateStructured: async (req: { model?: string }) => {
        seen.push(req.model);
        return {
          data: valid,
          model: req.model ?? '?',
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end' as const,
          raw: null,
        };
      },
    };
    await runPipeline(
      demoSummaryPipeline,
      { text: 't' },
      { ...ctx, models: { 'demo.summary': 'specific', default: 'dflt' } },
      { provider: real as never },
    );
    await runPipeline(
      demoSummaryPipeline,
      { text: 't' },
      { ...ctx, models: { default: 'dflt' } },
      { provider: real as never },
    );
    expect(seen).toEqual(['specific', 'dflt']);
    await expect(
      runPipeline(demoSummaryPipeline, { text: 't' }, ctx, { provider: real as never }),
    ).rejects.toBeInstanceOf(AiConfigError);
  });

  it('estimation du coût avec cache et tarif par modèle', () => {
    const table = parsePriceTable(
      JSON.stringify({
        default: { inputPerMTokEur: 1, outputPerMTokEur: 5 },
        models: { m: { inputPerMTokEur: 2, outputPerMTokEur: 10, cacheReadPerMTokEur: 0.2 } },
      }),
    );
    expect(estimateCostEur({ inputTokens: 1_000_000, outputTokens: 0 }, 'x', table)).toBe(1);
    expect(
      estimateCostEur(
        { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 },
        'm',
        table,
      ),
    ).toBe(1 + 0.1 + 1);
  });

  it('prompts : variables remplacées, variable manquante refusée', () => {
    expect(renderPrompt('a {{x}} b', { x: 3 })).toBe('a 3 b');
    expect(() => renderPrompt('{{y}}', {})).toThrow(/manquante/);
    expect(loadPrompt('demo.summary', { maxKeywords: 4 })).toContain('au plus 4 mots-clés');
  });
});
