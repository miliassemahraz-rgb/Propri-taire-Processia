import { describe, expect, it } from 'vitest';
import type { ElementStatus, StatusInfo } from '../schema/provenance.js';
import { type TransitionTarget, transitionStatus } from './status.js';
import type { StatusActor } from './types.js';

const FROM = [null, 'extracted', 'hypothesis', 'confirmed', 'validated'] as const;
const TO: TransitionTarget[] = ['extracted', 'hypothesis', 'confirmed', 'validated', 'rejected'];
const ACTORS: StatusActor[] = ['ai', 'system', 'consultant', 'mission_lead', 'validator'];

/** Cellules autorisées : (de, vers) -> acteurs permis. Toutes les autres sont interdites. */
const ALLOWED: Record<string, StatusActor[]> = {
  'null>extracted': ['ai', 'system'],
  'null>hypothesis': ['ai', 'system'],
  'null>confirmed': ['consultant', 'mission_lead'],
  'extracted>confirmed': ['consultant', 'mission_lead'],
  'hypothesis>confirmed': ['consultant', 'mission_lead'],
  'hypothesis>rejected': ['consultant', 'mission_lead'],
  'extracted>validated': ['validator'],
  'confirmed>validated': ['validator'],
  'validated>confirmed': ['system'],
};

const status = (v: ElementStatus | null): StatusInfo | null => (v === null ? null : { value: v });
const ctx = (actor: StatusActor) => ({
  actor,
  at: '2026-02-01T10:00:00.000Z',
  userId: 'u1',
  hasVerifiedSource: true,
  hasRationale: true,
  submissionId: 'sub-1',
  version: 4,
});

describe('transitionStatus : matrice complète (spécification 2.1)', () => {
  const cells = FROM.flatMap((from) => TO.map((to) => ({ from, to })));
  it.each(cells)('$from -> $to', ({ from, to }) => {
    const allowed = ALLOWED[`${from}>${to}`] ?? [];
    for (const actor of ACTORS) {
      const r = transitionStatus(status(from), to, ctx(actor));
      expect(r.ok, `${from} -> ${to} par ${actor}`).toBe(allowed.includes(actor));
    }
  });

  it('une transition interdite par la matrice porte le code FORBIDDEN_TRANSITION', () => {
    const r = transitionStatus(status('confirmed'), 'extracted', ctx('system'));
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN_TRANSITION' });
  });

  it('un acteur non autorisé porte le code FORBIDDEN_ACTOR', () => {
    expect(transitionStatus(status('extracted'), 'confirmed', ctx('ai'))).toMatchObject({
      ok: false,
      code: 'FORBIDDEN_ACTOR',
    });
  });

  it('conditions de création : source vérifiée, justification', () => {
    expect(
      transitionStatus(null, 'extracted', { ...ctx('ai'), hasVerifiedSource: false }),
    ).toMatchObject({ ok: false, code: 'MISSING_SOURCE' });
    expect(
      transitionStatus(null, 'hypothesis', { ...ctx('ai'), hasRationale: false }),
    ).toMatchObject({ ok: false, code: 'MISSING_RATIONALE' });
  });

  it('la validation exige une soumission', () => {
    const { submissionId: _omit, ...without } = ctx('validator');
    expect(transitionStatus(status('confirmed'), 'validated', without)).toMatchObject({
      ok: false,
      code: 'MISSING_SUBMISSION',
    });
  });

  it('validated -> confirmed renseigne changedAfterValidation', () => {
    const r = transitionStatus(status('validated'), 'confirmed', ctx('system'));
    expect(r).toMatchObject({
      ok: true,
      rejected: false,
      status: {
        value: 'confirmed',
        changedAfterValidation: { version: 4, at: '2026-02-01T10:00:00.000Z' },
      },
    });
  });

  it('une confirmation corrective conserve la valeur précédente', () => {
    const r = transitionStatus(status('hypothesis'), 'confirmed', {
      ...ctx('consultant'),
      correction: { previous: 'ancien', note: 'corrigé' },
    });
    expect(r).toMatchObject({
      ok: true,
      status: { value: 'confirmed', decidedBy: 'u1', correction: { previous: 'ancien' } },
    });
  });

  it('le rejet d’une hypothèse est signalé sans statut', () => {
    expect(transitionStatus(status('hypothesis'), 'rejected', ctx('consultant'))).toEqual({
      ok: true,
      rejected: true,
    });
  });
});
