import { buildCompleteModel, type BusinessModel, type Element } from '@processia/model';
import { describe, expect, it } from 'vitest';
import { buildRollback } from './rollback.js';

const AT = '2026-02-01T10:00:00.000Z';

function firstActor(model: BusinessModel): Element {
  const el = Object.values(model.elements).find((e) => e.kind === 'actor');
  if (el === undefined) throw new Error('acteur absent');
  return el;
}

describe('buildRollback', () => {
  it('reprend le contenu de la version cible sous le numéro N+1', () => {
    const target = { ...buildCompleteModel(), version: 1 };
    const head: BusinessModel = structuredClone({ ...target, version: 3 });
    const actor = firstActor(head);
    head.elements[actor.id] = { ...actor, label: 'Modifié' } as Element;
    const built = buildRollback(head, target, { at: AT });
    expect(built.model.version).toBe(4);
    expect(built.model.elements[actor.id]?.label).toBe(firstActor(target).label);
    expect(built.diff.modified.map((m) => m.id)).toEqual([actor.id]);
  });

  it('repasse à confirmed un élément validé dont le contenu change, avec la trace', () => {
    const target = { ...buildCompleteModel(), version: 1 };
    const head: BusinessModel = structuredClone({ ...target, version: 2 });
    const actor = firstActor(head);
    head.elements[actor.id] = {
      ...actor,
      label: 'Après validation',
      status: { value: 'validated', validatedInSubmission: 'sub-1' },
    } as Element;
    const built = buildRollback(head, target, { at: AT });
    const restored = built.model.elements[actor.id];
    expect(restored?.status.value).toBe('confirmed');
    expect(restored?.status.changedAfterValidation).toEqual({ version: 3, at: AT });
  });

  it('un élément validé identique dans la cible reste validé', () => {
    const base = buildCompleteModel();
    const actor = firstActor(base);
    const validated: BusinessModel = {
      ...base,
      elements: {
        ...base.elements,
        [actor.id]: {
          ...actor,
          status: { value: 'validated', validatedInSubmission: 's' },
        } as Element,
      },
    };
    const built = buildRollback(
      { ...validated, version: 5 },
      { ...validated, version: 2 },
      { at: AT },
    );
    expect(built.model.elements[actor.id]?.status.value).toBe('validated');
    expect(built.diff.added).toEqual([]);
    expect(built.diff.modified).toEqual([]);
  });

  it('retire les éléments absents de la cible et rétablit ceux qui y étaient', () => {
    const target = { ...buildCompleteModel(), version: 1 };
    const head: BusinessModel = structuredClone({ ...target, version: 2 });
    const actor = firstActor(head);
    delete head.elements[actor.id];
    const built = buildRollback(head, target, { at: AT });
    expect(built.diff.added).toEqual([actor.id]);
    const again = buildRollback({ ...target, version: 2 }, { ...head, version: 1 }, { at: AT });
    expect(again.diff.removed).toEqual([actor.id]);
  });
});
