import { beforeEach, describe, expect, it } from 'vitest';
import { parseModel } from '../parse.js';
import type { ModelOp } from '../schema/change-set.js';
import type { Optimisation } from '../schema/optimisation.js';
import {
  buildActor,
  buildCompleteModel,
  buildOptimisation,
  resetTestIds,
} from '../testing/index.js';
import type { BusinessModel } from '../schema/business-model.js';
import { composeToBe, ComposeToBeError, tryComposeToBe } from './compose.js';

const opt = (code: string, ops: ModelOp[], extra: Partial<Optimisation> = {}): Optimisation =>
  buildOptimisation({
    code,
    changeSet: { baseVersion: 1, cause: 'optimisation', summary: code, ops },
    ...extra,
  });

describe('composeToBe', () => {
  let asIs: BusinessModel;
  let taskId: string;
  beforeEach(() => {
    resetTestIds();
    asIs = buildCompleteModel();
    taskId = Object.values(asIs.elements).find((e) => e.kind === 'activity' && e.level === 'task')
      ?.id as string;
  });
  const setLabel = (label: string): ModelOp => ({ op: 'update', id: taskId, set: { label } });

  it('sans optimisation acceptée, renvoie le même contenu en version + 1', () => {
    const r = composeToBe(asIs, []);
    expect(r.version).toBe(asIs.version + 1);
    expect(r.elements).toEqual(asIs.elements);
  });

  it('applique les optimisations dans l’ordre topologique : la dépendante passe en dernier', () => {
    // B dépend de A mais son code précède celui de A : l'ordre topologique prime sur le code.
    const A = opt('OPT-9', [setLabel('depuis A')]);
    const B = opt('OPT-1', [setLabel('depuis B')], { dependsOn: [A.id] });
    const r = tryComposeToBe(asIs, [B, A]);
    expect(r).toMatchObject({ ok: true, order: [A.id, B.id] });
    expect(r.ok && r.model.elements[taskId]?.label).toBe('depuis B');
  });

  it('à dépendances égales, l’ordre est celui des codes, quel que soit l’ordre d’entrée', () => {
    const X = opt('OPT-1', [setLabel('X')]);
    const Y = opt('OPT-2', [setLabel('Y')]);
    const a = tryComposeToBe(asIs, [X, Y]);
    const b = tryComposeToBe(asIs, [Y, X]);
    expect(a.ok && a.order).toEqual([X.id, Y.id]);
    expect(b.ok && b.order).toEqual([X.id, Y.id]);
    expect(a).toEqual(b);
  });

  it('résout les identifiants temporaires, attribue des codes et reste valide', () => {
    const process = Object.values(asIs.elements).find(
      (e) => e.kind === 'activity' && e.level === 'process',
    )?.id as string;
    const step = buildActor({ code: '', label: 'Robot' });
    const O = opt('OPT-1', [
      { op: 'add', element: { ...step, id: 'tmp:1' } },
      { op: 'update', id: process, set: { responsibleActorId: 'tmp:1' } },
    ]);
    const r = composeToBe(asIs, [O]);
    const created = Object.values(r.elements).find((e) => e.label === 'Robot');
    expect(created?.code).toMatch(/^ACT-\d+$/);
    expect(created?.meta).toEqual({ createdInVersion: 2, updatedInVersion: 2 });
    expect(parseModel(JSON.parse(JSON.stringify(r))).ok).toBe(true);
  });

  it('est pur et déterministe', () => {
    const O = opt('OPT-1', [{ op: 'add', element: { ...buildActor({ code: '' }), id: 'tmp:1' } }]);
    const before = structuredClone(asIs);
    expect(composeToBe(asIs, [O])).toEqual(composeToBe(asIs, [O]));
    expect(asIs).toEqual(before);
  });

  it('deux optimisations qui ajoutent chacune un tmp:1 ne se heurtent pas', () => {
    const mk = (code: string) =>
      opt(code, [{ op: 'add', element: { ...buildActor({ code: '' }), id: 'tmp:1' } }]);
    const r = composeToBe(asIs, [mk('OPT-1'), mk('OPT-2')]);
    expect(Object.keys(r.elements).length).toBe(Object.keys(asIs.elements).length + 2);
  });

  it.each([
    [
      'cycle',
      () => {
        const A = opt('OPT-1', []);
        const B = opt('OPT-2', [], { dependsOn: [A.id] });
        A.dependsOn = [B.id];
        return [A, B];
      },
      'DEPENDENCY_CYCLE',
    ],
    [
      'dépendance non acceptée',
      () => [opt('OPT-2', [], { dependsOn: ['hors-liste'] })],
      'DEPENDENCY_NOT_ACCEPTED',
    ],
    [
      'ChangeSet inapplicable',
      () => [opt('OPT-1', [{ op: 'remove', id: taskId }])],
      'APPLY_FAILED',
    ],
  ])('échoue : %s', (_n, make, code) => {
    const list = make();
    expect(tryComposeToBe(asIs, list)).toMatchObject({ ok: false, error: { code } });
    expect(() => composeToBe(asIs, list)).toThrow(ComposeToBeError);
  });
});
