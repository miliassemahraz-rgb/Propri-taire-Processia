import { buildCompleteModel, type BusinessModel, type Element } from '@processia/model';
import { describe, expect, it } from 'vitest';
import {
  deliveredElements,
  excludedHypotheses,
  PHASE_AFTER_VALIDATION,
  phaseRank,
  submissionBlocker,
} from './scope.js';

function withStatus(
  model: BusinessModel,
  id: string,
  value: 'hypothesis' | 'extracted',
): BusinessModel {
  const el = model.elements[id] as Element;
  return {
    ...model,
    elements: { ...model.elements, [id]: { ...el, status: { value } } as Element },
  };
}

describe('périmètre des soumissions (WP-16)', () => {
  const model = buildCompleteModel();
  const actor = Object.values(model.elements).find((e) => e.kind === 'actor') as Element;

  it('livre les éléments validables et jamais les hypothèses', () => {
    const delivered = deliveredElements(model);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.some((e) => e.status.value === 'hypothesis')).toBe(false);
    const kinds = new Set(delivered.map((e) => e.kind));
    for (const never of ['discrepancy', 'finding', 'optimisation']) {
      expect(kinds.has(never as Element['kind'])).toBe(false);
    }
  });

  it('retire de la livraison une hypothèse et la liste comme exclue', () => {
    const changed = withStatus(model, actor.id, 'hypothesis');
    expect(deliveredElements(changed).some((e) => e.id === actor.id)).toBe(false);
    expect(excludedHypotheses(changed).map((e) => e.id)).toContain(actor.id);
    const back = withStatus(changed, actor.id, 'extracted');
    expect(deliveredElements(back).some((e) => e.id === actor.id)).toBe(true);
    expect(excludedHypotheses(back).map((e) => e.id)).not.toContain(actor.id);
  });

  it('trie par code', () => {
    const codes = deliveredElements(model).map((e) => e.code);
    expect(codes).toEqual([...codes].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
  });

  it('phases suivantes : dossier → cartographie, AS-IS → transformation, TO-BE → aucune', () => {
    expect(PHASE_AFTER_VALIDATION).toEqual({
      analysis_dossier: 'mapping',
      as_is: 'transformation',
      to_be: null,
    });
    expect(phaseRank('analysis')).toBeLessThan(phaseRank('mapping'));
    expect(phaseRank('mapping')).toBeLessThan(phaseRank('transformation'));
  });

  it('blocages de soumission', () => {
    const ok = { kind: 'analysis_dossier', phase: 'analysis', head: 3, deliveredCount: 5 } as const;
    expect(submissionBlocker({ ...ok, alreadyValidated: false })).toBeNull();
    expect(submissionBlocker({ ...ok, alreadyValidated: true })).toBe('ALREADY_VALIDATED');
    expect(submissionBlocker({ ...ok, head: 0, alreadyValidated: false })).toBe('EMPTY_MODEL');
    expect(submissionBlocker({ ...ok, deliveredCount: 0, alreadyValidated: false })).toBe(
      'EMPTY_MODEL',
    );
    expect(submissionBlocker({ ...ok, kind: 'as_is', alreadyValidated: false })).toBe(
      'WRONG_PHASE',
    );
    expect(
      submissionBlocker({ ...ok, kind: 'as_is', phase: 'mapping', alreadyValidated: false }),
    ).toBeNull();
    expect(submissionBlocker({ ...ok, kind: 'to_be', alreadyValidated: false })).toBe(
      'WRONG_PHASE',
    );
    expect(
      submissionBlocker({ ...ok, kind: 'to_be', phase: 'transformation', alreadyValidated: false }),
    ).toBeNull();
  });
});
