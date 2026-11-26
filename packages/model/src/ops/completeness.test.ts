import { beforeEach, describe, expect, it } from 'vitest';
import { CONCEPTS } from '../schema/kinds.js';
import {
  buildActor,
  buildBusinessTrait,
  buildCompleteModel,
  buildDiscrepancy,
  buildGlossaryTerm,
  buildModel,
  buildProvenance,
  buildStatus,
  resetTestIds,
} from '../testing/index.js';
import { completeness, overallCompleteness } from './completeness.js';

describe('completeness', () => {
  beforeEach(() => resetTestIds());

  it('un modèle vide vaut 0 pour chaque concept', () => {
    const r = completeness(buildModel([]));
    for (const c of CONCEPTS) {
      expect(r[c].score, c).toBe(0);
      expect(r[c].applicable, c).toBeGreaterThan(0);
    }
    expect(overallCompleteness(r)).toBe(0);
  });

  it('le modèle complet de test vaut 1 pour chaque concept, sans manque', () => {
    const r = completeness(buildCompleteModel());
    for (const c of CONCEPTS) {
      expect(r[c].gaps, c).toEqual([]);
      expect(r[c].score, c).toBe(1);
    }
    expect(overallCompleteness(r)).toBe(1);
  });

  it('le score est satisfaits / applicables et les manques sont listés avec leur élément', () => {
    const m = buildModel([
      buildBusinessTrait({ facet: 'sector' }),
      buildBusinessTrait({ facet: 'environment' }),
      buildGlossaryTerm({ definition: ' ' }),
    ]);
    const r = completeness(m).business;
    expect(r).toMatchObject({ satisfied: 2, applicable: 5, score: 0.4 });
    expect(r.gaps.map((g) => g.check).sort()).toEqual([
      'business.specificity',
      'business.summary',
      'business.term_definition',
    ]);
    expect(r.gaps.find((g) => g.check === 'business.term_definition')?.elementId).toBeTruthy();
  });

  it('compte les hypothèses en attente et les questions ouvertes par concept', () => {
    const actor = buildActor({
      status: buildStatus({ value: 'hypothesis' }),
      provenance: buildProvenance({
        origin: 'ai_knowledge',
        rationale: 'r',
        author: { type: 'ai' },
      }),
    });
    const open = buildDiscrepancy({ elementIds: [actor.id] });
    const resolved = buildDiscrepancy({
      elementIds: [actor.id],
      state: 'resolved',
      resolution: { note: 'ok', by: 'u', at: '2026-01-01T00:00:00.000Z' },
    });
    const r = completeness(buildModel([actor, open, resolved]));
    expect(r.actors.pendingHypotheses).toBe(1);
    expect(r.actors.openQuestions).toBe(1);
    expect(r.business.pendingHypotheses).toBe(0);
  });

  it.each([
    ['actors.responsibility', () => buildActor({ responsibilities: [] })],
    ['actors.in_raci_or_flow', () => buildActor()],
  ])('contrôle %s', (check, make) => {
    const gaps = completeness(buildModel([make()])).actors.gaps.map((g) => g.check);
    expect(gaps).toContain(check);
  });
});
