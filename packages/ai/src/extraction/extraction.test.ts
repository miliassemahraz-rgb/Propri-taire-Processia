import {
  PILOT_ACTORS,
  PILOT_CONTRADICTORY_DOCUMENT,
  PILOT_DESCRIPTION,
  PILOT_MACROS,
  PILOT_SCENARIOS,
  PILOT_STAKEHOLDERS,
  type ScenarioRequest,
} from '@processia/test-fixtures';
import {
  applyChangeSet,
  CURRENT_SCHEMA_VERSION,
  uuidv7,
  type Activity,
  type Actor,
  type BusinessModel,
  type Discrepancy,
  type Element,
} from '@processia/model';
import { describe, expect, it } from 'vitest';
import { FakeProvider, type FakeScenario } from '../fake-provider.js';
import {
  extractionChunkPipeline,
  reconcilePipeline,
  type ChunkInput,
  type ExtractionCandidate,
} from '../pipelines/extraction.js';
import { runPipeline } from '../runner.js';
import {
  CITATION_NOT_FOUND,
  mergeCandidates,
  matchExisting,
  summarizeCandidates,
  summarizeModel,
  verifyChunkCandidates,
  type VerifiedCandidate,
} from './candidates.js';
import { buildExtractionChangeSet } from './changeset.js';
import { applyReconcileResult, prepareReconcileInput } from './plan.js';
import { normalizeForMatch, verifyCitation } from './text.js';

const MISSION = '01900000-0000-7000-8000-000000000001';
const AT = '2026-11-26T10:00:00.000Z';

const emptyModel = (): BusinessModel => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  missionId: MISSION,
  version: 0,
  elements: {},
  rejectedHypotheses: [],
  layout: {},
});

function provider(overrides: Record<string, FakeScenario> = {}): FakeProvider {
  return new FakeProvider({
    scenarios: {
      ...(PILOT_SCENARIOS as Record<string, (req: ScenarioRequest) => unknown>),
      ...overrides,
    } as Record<string, FakeScenario>,
  });
}

let idCounter = 0;
const newId = (): string => {
  idCounter += 1;
  return uuidv7(1_700_000_000_000 + idCounter, new Uint8Array(10).fill(idCounter % 251));
};

let chunkCounter = 0;
function chunkOf(
  text: string,
  sourceRevision = 1,
  sourceId = '01900000-0000-7000-8000-0000000000aa',
): ChunkInput {
  chunkCounter += 1;
  return {
    chunkId: `chunk-${chunkCounter}`,
    sourceId,
    sourceRevision,
    origin: 'free_text',
    title: 'Description du métier',
    text,
    locator: { paragraph: 1 },
  };
}

interface Outcome {
  model: BusinessModel;
  changeSet: ReturnType<typeof buildExtractionChangeSet>['changeSet'];
  stats: ReturnType<typeof buildExtractionChangeSet>['stats'];
  reconcileCalls: number;
}

/** Même enchaînement que le job `analysis.extraction`, sans base ni HTTP. */
async function extractInto(
  model: BusinessModel,
  chunk: ChunkInput,
  fake: FakeProvider,
): Promise<Outcome> {
  const deps = { provider: fake };
  const ctx = { clientId: 'client' };
  const { output } = await runPipelineWith(extractionChunkPipeline, {
    chunk,
    model: summarizeModel(model),
  });
  const verified = verifyChunkCandidates(
    { chunk, candidates: output.candidates, aiCallId: 'call-1' },
    0,
  );
  const merged = mergeCandidates(verified);
  let matches = matchExisting(merged.candidates, merged.mergedInto, model);
  let plan = {
    candidates: merged.candidates,
    mergedInto: merged.mergedInto,
    matches,
    discrepancies: [] as never[],
  };
  let reconcileCalls = 0;
  if (Object.keys(model.elements).length > 0) {
    reconcileCalls = 1;
    const result = await runPipeline(
      reconcilePipeline,
      prepareReconcileInput(merged.candidates, matches, model),
      ctx,
      deps,
    );
    plan = applyReconcileResult({ ...merged, matches }, result, model) as typeof plan;
    matches = plan.matches;
  }
  const built = buildExtractionChangeSet({ model, ...plan, at: AT });
  if (built.changeSet === null)
    return { model, changeSet: null, stats: built.stats, reconcileCalls };
  const applied = applyChangeSet(model, built.changeSet, { newId, at: AT, actor: 'ai' });
  if (!applied.ok) throw new Error(JSON.stringify(applied.errors, null, 2));
  return { model: applied.model, changeSet: built.changeSet, stats: built.stats, reconcileCalls };

  function runPipelineWith<I, O>(
    def: Parameters<typeof runPipeline<I, O>>[0],
    input: I,
  ): Promise<{ output: O }> {
    return runPipeline(def, input, ctx, deps).then((output) => ({ output }));
  }
}

const elements = (m: BusinessModel): Element[] => Object.values(m.elements);
const activities = (m: BusinessModel): Activity[] =>
  elements(m).filter((e): e is Activity => e.kind === 'activity');
const actors = (m: BusinessModel): Actor[] =>
  elements(m).filter((e): e is Actor => e.kind === 'actor');

describe('vérification des citations (4.5)', () => {
  it('normalise les espaces, apostrophes, guillemets, casse et Unicode', () => {
    const text = 'Le cabinet  reçoit  l’avis « final » du client.\nLigne suivante.';
    const found = verifyCitation(text, "L'AVIS « final » du client. ligne");
    expect(found).not.toBeNull();
    expect(text.slice(found?.charStart, found?.charEnd)).toBe('l’avis « final » du client.\nLigne');
    // Forme décomposée (e + accent combinant) contre forme composée.
    expect(verifyCitation('Il y a un e\u0301te\u0301 chaud', 'été')).toEqual({
      charStart: 10,
      charEnd: 15,
    });
    expect(normalizeForMatch('\u00C9')).toBe(normalizeForMatch('E\u0301'));
  });

  it('refuse une citation absente ou vide', () => {
    expect(
      verifyCitation('Le cabinet reçoit les dossiers.', 'Le cabinet refuse les dossiers.'),
    ).toBeNull();
    expect(verifyCitation('texte', '   ')).toBeNull();
  });
});

describe('scénario factice du pilote : validité', () => {
  it('chaque sortie scriptée passe le schéma et le contrôle sémantique', async () => {
    const chunk = chunkOf(PILOT_DESCRIPTION);
    const out = await runPipeline(
      extractionChunkPipeline,
      { chunk, model: [] },
      { clientId: 'c' },
      { provider: provider() },
    );
    expect(out.candidates.length).toBeGreaterThan(60);
    const second = await runPipeline(
      extractionChunkPipeline,
      { chunk: chunkOf(PILOT_CONTRADICTORY_DOCUMENT), model: [] },
      { clientId: 'c' },
      { provider: provider() },
    ).catch((e: unknown) => e);
    // Le parent « P04 » n'existe ni dans le morceau ni dans le modèle : reprise puis erreur sémantique.
    expect(second).toBeInstanceOf(Error);
  });
});

describe('extraction du pilote (acceptation WP-12, sans base)', () => {
  it('1. produit les 14 macroprocessus, 8 acteurs, 4 parties prenantes et les activités', async () => {
    const outcome = await extractInto(emptyModel(), chunkOf(PILOT_DESCRIPTION), provider());
    const m = outcome.model;
    const macros = activities(m).filter((a) => a.level === 'macro');
    expect(macros.map((a) => a.code).sort()).toEqual(PILOT_MACROS.map((p) => p.code).sort());
    for (const expected of PILOT_MACROS) {
      const macro = macros.find((a) => a.code === expected.code) as Activity;
      expect(macro.label).toBe(expected.label);
      expect(macro.scope).toBe(expected.scope);
      expect(macro.status.value).toBe('extracted');
      expect(macro.provenance.refs).toHaveLength(1);
      const ref = macro.provenance.refs[0]!;
      expect(PILOT_DESCRIPTION.slice(ref.locator.charStart, ref.locator.charEnd)).toBe(ref.quote);
      expect(ref.quote).toContain(expected.label);
      const children = activities(m).filter((a) => a.parentId === macro.id);
      expect(children.map((c) => c.label)).toEqual(expected.activities.map((x) => x.label));
      for (const child of children) {
        expect(child.level).toBe('process');
        expect(child.status.value).toBe('extracted');
        expect(child.code).toMatch(new RegExp(`^${expected.code}\\.\\d+$`));
      }
    }
    expect(activities(m).filter((a) => a.level === 'process')).toHaveLength(
      PILOT_MACROS.reduce((n, p) => n + p.activities.length, 0),
    );

    const people = actors(m);
    const internal = people.filter((a) => a.stakeholder !== true);
    expect(internal.map((a) => a.label).sort()).toEqual(PILOT_ACTORS.map((a) => a.label).sort());
    const external = people.filter((a) => a.stakeholder === true);
    expect(external.map((a) => a.label).sort()).toEqual(
      PILOT_STAKEHOLDERS.map((a) => a.label).sort(),
    );
    // Le responsable des relances clients est l'assistant administratif (CDC 8.3).
    const relances = activities(m).find((a) => a.label === 'Relances clients') as Activity;
    const assistant = people.find((a) => a.label === 'Assistant administratif') as Actor;
    expect(relances.responsibleActorId).toBe(assistant.id);

    // Aucun élément confirmé ; tous extraits avec citation vérifiée.
    expect(elements(m).every((e) => e.status.value === 'extracted')).toBe(true);
    expect(elements(m).every((e) => e.provenance.refs.length > 0)).toBe(true);
    expect(outcome.stats.citationsDemoted).toBe(0);
  });

  it('1 (suite). un second document contradictoire produit un écart ouvert', async () => {
    const first = await extractInto(emptyModel(), chunkOf(PILOT_DESCRIPTION), provider());
    const second = await extractInto(
      first.model,
      chunkOf(PILOT_CONTRADICTORY_DOCUMENT, 1, '01900000-0000-7000-8000-0000000000bb'),
      provider(),
    );
    expect(second.reconcileCalls).toBe(1);
    const gaps = elements(second.model).filter((e): e is Discrepancy => e.kind === 'discrepancy');
    expect(gaps).toHaveLength(1);
    const gap = gaps[0]!;
    expect(gap.state).toBe('open');
    expect(gap.status.value).toBe('extracted');
    expect(gap.sides).toHaveLength(2);
    expect(gap.sides[0]?.claim).toContain('Assistant administratif');
    expect(gap.sides[1]?.claim).toContain('Collaborateur comptable');
    expect(gap.sides[0]?.refs.length).toBeGreaterThan(0);
    expect(gap.sides[1]?.refs.length).toBeGreaterThan(0);
    expect(gap.code).toMatch(/^ECA-\d+$/);
    // Le fait de la première source n'est pas modifié : l'outil signale, il ne tranche pas.
    const relances = activities(second.model).filter((a) => a.label === 'Relances clients');
    expect(relances).toHaveLength(1);
    // Rejouer le second document ne répète pas l'écart.
    const again = await extractInto(
      second.model,
      chunkOf(PILOT_CONTRADICTORY_DOCUMENT, 1, '01900000-0000-7000-8000-0000000000bb'),
      provider(),
    );
    expect(again.stats.discrepancies).toBe(0);
  });

  it('2. une citation altérée est rétrogradée en hypothèse', async () => {
    const real = PILOT_SCENARIOS['extraction.chunk'] as (req: ScenarioRequest) => unknown;
    const tampered: FakeScenario = (req) => {
      const out = real(req as ScenarioRequest) as { candidates: ExtractionCandidate[] };
      return {
        candidates: out.candidates.map((c) =>
          c.label === 'Prospection commerciale'
            ? { ...c, quote: `${c.quote ?? ''} (texte inventé par le modèle)` }
            : c,
        ),
      };
    };
    const outcome = await extractInto(
      emptyModel(),
      chunkOf(PILOT_DESCRIPTION),
      provider({ 'extraction.chunk': tampered }),
    );
    const macro = activities(outcome.model).find(
      (a) => a.code === 'P01' || a.label === 'Prospection commerciale',
    ) as Activity;
    expect(macro.status.value).toBe('hypothesis');
    expect(macro.provenance.rationale).toContain(CITATION_NOT_FOUND);
    expect(macro.provenance.refs).toEqual([]);
    expect(macro.provenance.origin).toBe('ai_knowledge');
    expect(outcome.stats.citationsDemoted).toBe(1);
    // Les processus de P01, eux, gardent leur citation vérifiée.
    const children = activities(outcome.model).filter((a) => a.parentId === macro.id);
    expect(children).toHaveLength(3);
    expect(children.every((c) => c.status.value === 'extracted')).toBe(true);
    // Le reste du modèle est intact.
    expect(elements(outcome.model).filter((e) => e.status.value === 'hypothesis')).toHaveLength(1);
  });

  it('3. relancer l’extraction sur la même source ne crée aucun doublon', async () => {
    const chunk = chunkOf(PILOT_DESCRIPTION);
    const first = await extractInto(emptyModel(), chunk, provider());
    const count = Object.keys(first.model.elements).length;
    const second = await extractInto(first.model, chunk, provider());
    expect(second.changeSet).toBeNull();
    expect(second.stats.created).toBe(0);
    expect(second.stats.matched).toBe(second.stats.candidates);
    expect(Object.keys(second.model.elements)).toHaveLength(count);
  });

  it('3 (suite). une nouvelle révision corrobore les éléments existants sans les dupliquer', async () => {
    const first = await extractInto(emptyModel(), chunkOf(PILOT_DESCRIPTION, 1), provider());
    const count = Object.keys(first.model.elements).length;
    const second = await extractInto(first.model, chunkOf(PILOT_DESCRIPTION, 2), provider());
    expect(second.stats.created).toBe(0);
    expect(second.stats.refsAdded).toBe(count);
    expect(Object.keys(second.model.elements)).toHaveLength(count);
    const macro = activities(second.model).find((a) => a.code === 'P01') as Activity;
    expect(macro.provenance.refs.map((r) => r.sourceRevision)).toEqual([1, 2]);
  });

  it('un candidat sans citation est une hypothèse justifiée, jamais confirmé', async () => {
    const inferred: FakeScenario = (req) => {
      const m = /<morceau id="([^"]+)"/.exec((req.messages.at(-1) as { content: string }).content);
      return {
        candidates: [
          {
            ref: 'c1',
            kind: 'tool',
            label: 'GED',
            chunkId: m?.[1] ?? '',
            rationale: 'Le texte évoque un espace de dépôt documentaire.',
            tool: { nature: 'software' },
          },
        ],
      };
    };
    const outcome = await extractInto(
      emptyModel(),
      chunkOf('Les documents sont déposés dans un espace partagé.'),
      provider({ 'extraction.chunk': inferred }),
    );
    const [only] = elements(outcome.model);
    expect(only?.status.value).toBe('hypothesis');
    expect(only?.provenance.origin).toBe('ai_knowledge');
    expect(only?.provenance.rationale).toBe('Le texte évoque un espace de dépôt documentaire.');
    expect(only?.provenance.author.type).toBe('ai');
  });

  it('résume les candidats déjà traités pour le morceau suivant', () => {
    const chunk = chunkOf('Le processus P09, Clôture comptable, couvre les comptes annuels.');
    const verified: VerifiedCandidate[] = verifyChunkCandidates(
      {
        chunk,
        aiCallId: null,
        candidates: [
          {
            ref: 'c1',
            kind: 'activity',
            label: 'Clôture comptable',
            code: 'P09',
            chunkId: chunk.chunkId,
            quote: 'Clôture comptable',
            activity: { level: 'macro' },
          },
        ],
      },
      3,
    );
    expect(verified[0]?.key).toBe('3:c1');
    expect(summarizeCandidates(verified)).toEqual([
      { code: 'P09', kind: 'activity', label: 'Clôture comptable', level: 'macro', pending: true },
    ]);
  });
});
