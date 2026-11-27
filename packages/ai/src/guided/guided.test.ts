import {
  PILOT_ANSWER_ENVIRONMENT,
  PILOT_ANSWER_SAISIE,
  PILOT_DESCRIPTION,
  PILOT_GUIDED_SCENARIOS,
  PILOT_HYPOTHESES,
  PILOT_QUESTION_ENVIRONMENT,
  PILOT_SCENARIOS,
  type ScenarioRequest,
} from '@processia/test-fixtures';
import {
  applyChangeSet,
  completeness,
  CURRENT_SCHEMA_VERSION,
  uuidv7,
  type BusinessModel,
  type BusinessTrait,
  type ChangeSet,
} from '@processia/model';
import { describe, expect, it } from 'vitest';
import {
  matchExisting,
  mergeCandidates,
  summarizeModel,
  verifyChunkCandidates,
} from '../extraction/candidates.js';
import { buildExtractionChangeSet } from '../extraction/changeset.js';
import { FakeProvider, type FakeScenario } from '../fake-provider.js';
import { extractionChunkPipeline, type ChunkInput } from '../pipelines/extraction.js';
import {
  answerIntegratePipeline,
  hypothesesPipeline,
  questionsPipeline,
  rankQuestions,
  summaryPipeline,
  type HypothesesOutput,
  type QuestionsOutput,
} from '../pipelines/guided.js';
import { runPipeline } from '../runner.js';
import {
  buildHypothesesChangeSet,
  buildHypothesesInput,
  buildQuestionsInput,
  buildSummaryChangeSet,
  summaryTraits,
} from './plan.js';

const MISSION = '01900000-0000-7000-8000-000000000001';
const AT = '2026-11-27T10:00:00.000Z';
const fake = new FakeProvider({
  scenarios: {
    ...(PILOT_SCENARIOS as Record<string, (req: ScenarioRequest) => unknown>),
    ...PILOT_GUIDED_SCENARIOS,
  } as Record<string, FakeScenario>,
});
const deps = { provider: fake };
const ctx = { clientId: 'client' };

let counter = 0;
const newId = (): string => {
  counter += 1;
  return uuidv7(1_700_000_000_000 + counter, new Uint8Array(10).fill(counter % 251));
};

const empty = (): BusinessModel => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  missionId: MISSION,
  version: 0,
  elements: {},
  rejectedHypotheses: [],
  layout: {},
});

function apply(model: BusinessModel, cs: ChangeSet, actor: 'ai' | 'consultant' = 'ai') {
  const res = applyChangeSet(model, cs, { newId, at: AT, actor, userId: 'user-1' });
  if (!res.ok) throw new Error(JSON.stringify(res.errors, null, 2));
  return res.model;
}

function chunk(text: string, origin: ChunkInput['origin'] = 'free_text'): ChunkInput {
  return {
    chunkId: 'chunk-1',
    sourceId: '01900000-0000-7000-8000-0000000000aa',
    sourceRevision: 1,
    origin,
    title: 'Source',
    text,
    locator: { paragraph: 1 },
  };
}

/** Modèle du pilote : l'extraction de la description, comme le fait « Analyser ». */
async function pilotModel(): Promise<BusinessModel> {
  const model = empty();
  const c = chunk(PILOT_DESCRIPTION);
  const out = await runPipeline(
    extractionChunkPipeline,
    { chunk: c, model: summarizeModel(model) },
    ctx,
    deps,
  );
  const merged = mergeCandidates(
    verifyChunkCandidates({ chunk: c, candidates: out.candidates, aiCallId: 'call' }, 0),
  );
  const built = buildExtractionChangeSet({
    model,
    ...merged,
    matches: matchExisting(merged.candidates, merged.mergedInto, model),
    discrepancies: [],
    at: AT,
  });
  return apply(model, built.changeSet as ChangeSet);
}

describe('questions', () => {
  it('classe par effet bloquant : la première question est la plus bloquante', async () => {
    const model = await pilotModel();
    const input = buildQuestionsInput(model, summarizeModel(model), []);
    const output = await runPipeline(questionsPipeline, input, ctx, deps);
    const ranked = rankQuestions(output, []);
    expect(ranked.length).toBeGreaterThanOrEqual(5);
    expect(ranked[0]?.text).toBe(PILOT_QUESTION_ENVIRONMENT);
    const scores = ranked.map((q) => q.blockingScore);
    expect(ranked[0]?.blockingScore).toBe(Math.max(...scores));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('le rapport transmis est trié par code et porte les manques de chaque concept', async () => {
    const model = await pilotModel();
    const input = buildQuestionsInput(model, summarizeModel(model), ['déjà posée']);
    expect(input.report.map((r) => r.concept)).toHaveLength(7);
    const tasks = input.report
      .find((r) => r.concept === 'activities')
      ?.gaps.filter((g) => g.check === 'activities.process_has_task')
      .map((g) => g.elementCode);
    expect(tasks).toHaveLength(45);
    expect(tasks?.slice(0, 3)).toEqual(['P01.1', 'P01.2', 'P01.3']);
    expect(input.asked).toEqual(['déjà posée']);
  });

  it('rejette une question déjà posée, un code inconnu et un doublon (contrôle sémantique)', () => {
    const model = [{ code: 'P01', kind: 'activity', label: 'Prospection' }];
    const base = { report: [], discrepancies: [], model, asked: ['Quelle est la règle ?'] };
    const q = (text: string, targetCodes: string[] = []) => ({
      text,
      concept: 'rules' as const,
      targetCodes,
      blockingScore: 50,
      rationale: 'x',
    });
    const output: QuestionsOutput = {
      questions: [q('quelle est la règle ?'), q('Autre', ['ZZ']), q('Autre')],
    };
    const issues = questionsPipeline.semanticCheck?.(output, base, ctx) ?? [];
    expect(issues.map((i) => i.path)).toEqual([
      'questions.0.text',
      'questions.1.targetCodes.0',
      'questions.2.text',
    ]);
  });

  it('rankQuestions écarte les questions déjà posées et garde l’ordre à égalité de score', () => {
    const q = (text: string, blockingScore: number) => ({
      text,
      concept: 'rules' as const,
      targetCodes: [],
      blockingScore,
      rationale: 'x',
    });
    const ranked = rankQuestions({ questions: [q('B', 40), q('A', 40), q('C', 90), q('D', 10)] }, [
      'd',
    ]);
    expect(ranked.map((r) => r.text)).toEqual(['C', 'B', 'A']);
  });
});

describe('answer.integrate', () => {
  it('une réponse donne des candidats cités, intégrés avec la cause `answer` et jamais confirmés', async () => {
    const model = await pilotModel();
    const c = chunk(PILOT_ANSWER_SAISIE, 'answer');
    const summary = summarizeModel(model);
    const out = await runPipeline(
      answerIntegratePipeline,
      {
        question: { text: 'Quelles sont les tâches de Saisie ?', concept: 'activities' },
        model: summary,
        targets: summary.filter((e) => e.label === 'Saisie'),
        chunk: c,
      },
      ctx,
      deps,
    );
    const verified = verifyChunkCandidates(
      { chunk: c, candidates: out.candidates, aiCallId: 'x' },
      0,
    );
    expect(verified).toHaveLength(3);
    expect(verified.every((v) => v.refs.length === 1 && !v.demoted)).toBe(true);
    const merged = mergeCandidates(verified);
    const built = buildExtractionChangeSet({
      model,
      ...merged,
      matches: matchExisting(merged.candidates, merged.mergedInto, model),
      discrepancies: [],
      at: AT,
      cause: 'answer',
      summary: 'Réponse',
    });
    expect(built.changeSet?.cause).toBe('answer');
    const next = apply(model, built.changeSet as ChangeSet);
    const tasks = Object.values(next.elements).filter(
      (e) => e.kind === 'activity' && e.level === 'task',
    );
    expect(tasks).toHaveLength(3);
    expect(
      tasks.every((t) => t.status.value === 'extracted' && t.provenance.origin === 'answer'),
    ).toBe(true);
    expect(completeness(next).activities.score).toBeGreaterThan(
      completeness(model).activities.score,
    );
    // Rejouer la même réponse ne crée rien de plus.
    const again = buildExtractionChangeSet({
      model: next,
      ...merged,
      matches: matchExisting(merged.candidates, merged.mergedInto, next),
      discrepancies: [],
      at: AT,
      cause: 'answer',
    });
    expect(again.stats.created).toBe(0);
  });

  it('la réponse sur l’environnement crée le trait manquant et la complétude du métier augmente', async () => {
    const model = await pilotModel();
    const c = chunk(PILOT_ANSWER_ENVIRONMENT, 'answer');
    const out = await runPipeline(
      answerIntegratePipeline,
      {
        question: { text: PILOT_QUESTION_ENVIRONMENT, concept: 'business' },
        model: summarizeModel(model),
        targets: [],
        chunk: c,
      },
      ctx,
      deps,
    );
    const merged = mergeCandidates(
      verifyChunkCandidates({ chunk: c, candidates: out.candidates, aiCallId: 'x' }, 0),
    );
    const built = buildExtractionChangeSet({
      model,
      ...merged,
      matches: matchExisting(merged.candidates, merged.mergedInto, model),
      discrepancies: [],
      at: AT,
      cause: 'answer',
    });
    const next = apply(model, built.changeSet as ChangeSet);
    expect(completeness(next).business.score).toBeGreaterThan(completeness(model).business.score);
  });
});

describe('hypotheses', () => {
  const run = async (model: BusinessModel): Promise<HypothesesOutput> =>
    runPipeline(hypothesesPipeline, buildHypothesesInput(model, summarizeModel(model)), ctx, deps);

  it('produit des hypothèses justifiées, sans citation, avec la cause `hypotheses`', async () => {
    const model = await pilotModel();
    const output = await run(model);
    const built = buildHypothesesChangeSet({ model, output, aiCallId: 'call-h', at: AT });
    expect(built.changeSet?.cause).toBe('hypotheses');
    const next = apply(model, built.changeSet as ChangeSet);
    const hyps = Object.values(next.elements).filter((e) => e.status.value === 'hypothesis');
    expect(hyps.map((h) => h.label).sort()).toEqual(
      PILOT_HYPOTHESES.map((h) => h.proposal.label).sort(),
    );
    for (const h of hyps) {
      expect(h.provenance).toMatchObject({ origin: 'ai_knowledge', refs: [], aiCallId: 'call-h' });
      expect(h.provenance.rationale).toBeTruthy();
    }
    // La tâche proposée est rattachée à son processus.
    const task = hyps.find((h) => h.kind === 'activity');
    expect(task).toMatchObject({ level: 'task' });
    // Rejouer sans changement ne crée rien.
    const again = buildHypothesesChangeSet({ model: next, output, aiCallId: 'x', at: AT });
    expect(again.changeSet).toBeNull();
  });

  it('une hypothèse rejetée n’est pas reproposée : le scénario l’omet et le code la filtre', async () => {
    const model = await pilotModel();
    const built = buildHypothesesChangeSet({
      model,
      output: await run(model),
      aiCallId: null,
      at: AT,
    });
    let next = apply(model, built.changeSet as ChangeSet);
    const tool = Object.values(next.elements).find((e) => e.label === 'Logiciel de GED') as {
      id: string;
    };
    next = apply(
      next,
      {
        baseVersion: next.version,
        cause: 'hypothesis_decision',
        summary: 'rejet',
        ops: [{ op: 'reject_hypothesis', id: tool.id, reason: 'non' }],
      },
      'consultant',
    );
    expect(next.rejectedHypotheses).toHaveLength(1);
    const output = await run(next);
    expect(output.proposals.map((p) => p.label)).not.toContain('Logiciel de GED');
    // Un fournisseur qui l'enverrait quand même : refusé par le contrôle, écarté par le code.
    const stubborn: HypothesesOutput = {
      proposals: [
        {
          ref: 'h1',
          kind: 'tool',
          label: 'logiciel  de GED',
          rationale: 'plausible',
          tool: { nature: 'software' },
        },
      ],
    };
    const input = buildHypothesesInput(next, summarizeModel(next));
    expect(hypothesesPipeline.semanticCheck?.(stubborn, input, ctx)).toHaveLength(1);
    const filtered = buildHypothesesChangeSet({
      model: next,
      output: stubborn,
      aiCallId: null,
      at: AT,
    });
    expect(filtered.changeSet).toBeNull();
    expect(filtered.rejectedSkipped).toBe(1);
  });

  it('exige le détail propre à la nature et le parent d’une tâche', () => {
    const issues =
      hypothesesPipeline.semanticCheck?.(
        {
          proposals: [
            { ref: 'a', kind: 'actor', label: 'X', rationale: 'r' },
            { ref: 'b', kind: 'activity', label: 'Y', rationale: 'r', activity: { level: 'task' } },
          ],
        },
        { model: [], gaps: [], rejected: [] },
        ctx,
      ) ?? [];
    expect(issues.map((i) => i.path)).toEqual(['proposals.0.actor', 'proposals.1.activity.parent']);
  });
});

describe('deliverable.summary', () => {
  it('rédige une synthèse hypothétique à partir des caractéristiques non hypothétiques', async () => {
    const model = await pilotModel();
    const traits = summaryTraits(model);
    expect(traits.length).toBeGreaterThan(0);
    const output = await runPipeline(
      summaryPipeline,
      { traits: traits.map((t) => ({ facet: t.facet, label: t.label, text: t.text })) },
      ctx,
      deps,
    );
    const built = buildSummaryChangeSet({ model, output, aiCallId: 'c', at: AT });
    expect(built.changeSet?.cause).toBe('hypotheses');
    const next = apply(model, built.changeSet as ChangeSet);
    const summary = Object.values(next.elements).find(
      (e): e is BusinessTrait => e.kind === 'business_trait' && e.facet === 'summary',
    ) as BusinessTrait;
    expect(summary.status.value).toBe('hypothesis');
    expect(summary.provenance.origin).toBe('ai_knowledge');
    // Une hypothèse de synthèse est réécrite ; une synthèse confirmée n'est jamais écrasée.
    const rewritten = buildSummaryChangeSet({
      model: next,
      output: { text: 'Une nouvelle synthèse du métier du cabinet.', rationale: 'r' },
      aiCallId: null,
      at: AT,
    });
    expect(rewritten.changeSet?.ops[0]?.op).toBe('update');
    const confirmed = apply(
      next,
      {
        baseVersion: next.version,
        cause: 'hypothesis_decision',
        summary: 'ok',
        ops: [{ op: 'set_status', id: summary.id, status: 'confirmed' }],
      },
      'consultant',
    );
    expect(
      buildSummaryChangeSet({ model: confirmed, output, aiCallId: null, at: AT }).changeSet,
    ).toBeNull();
  });

  it('refuse une synthèse trop courte', () => {
    expect(
      summaryPipeline.semanticCheck?.({ text: 'Court', rationale: 'r' }, { traits: [] }, ctx),
    ).toHaveLength(1);
  });
});
