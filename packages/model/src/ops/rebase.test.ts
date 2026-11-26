import { beforeEach, describe, expect, it } from 'vitest';
import type { ChangeSet, ModelOp } from '../schema/change-set.js';
import { buildActivity, buildActor, buildModel, resetTestIds } from '../testing/index.js';
import { applyChangeSet } from './apply.js';
import { diffModels } from './diff.js';
import { rebase } from './rebase.js';

const cs = (ops: ModelOp[], baseVersion = 1): ChangeSet => ({
  baseVersion,
  ops,
  cause: 'dialogue_edit',
  summary: 'Test',
});

describe('diffModels', () => {
  beforeEach(() => resetTestIds());
  it('liste les ajoutés, retirés, modifiés (par champ) et les dispositions', () => {
    const a = buildActor();
    const b = buildActor();
    const c = buildActor();
    const m1 = buildModel([a, b]);
    const m2 = buildModel([{ ...a, label: 'Autre', description: 'd' }, c], {
      layout: { L0: { [a.id]: { x: 0, y: 0, w: 1, h: 1 } } },
    });
    expect(diffModels(m1, m2)).toEqual({
      added: [c.id],
      removed: [b.id],
      modified: [{ id: a.id, fields: ['description', 'label'] }],
      layout: ['L0'],
    });
  });
  it('ignore meta et renvoie un diff vide pour deux modèles égaux', () => {
    const a = buildActor();
    const m = buildModel([a]);
    const m2 = buildModel([{ ...a, meta: { createdInVersion: 1, updatedInVersion: 9 } }]);
    expect(diffModels(m, m2)).toEqual({ added: [], removed: [], modified: [], layout: [] });
  });
});

describe('rebase', () => {
  let a: ReturnType<typeof buildActor>;
  let b: ReturnType<typeof buildActor>;
  let base: ReturnType<typeof buildModel>;
  beforeEach(() => {
    resetTestIds();
    a = buildActor();
    b = buildActor();
    base = buildModel([a, b]);
  });

  /** Version intercalée : un autre utilisateur applique `other` sur la base. */
  function intervene(other: ModelOp[]) {
    const r = applyChangeSet(base, cs(other));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return { head: r.model, diff: r.diff };
  }

  it('réussit sur des ensembles disjoints et repart de la nouvelle version', () => {
    const { head, diff } = intervene([{ op: 'update', id: a.id, set: { label: 'A2' } }]);
    const mine = cs([{ op: 'update', id: b.id, set: { label: 'B2' } }]);
    const r = rebase(mine, [diff], head);
    expect(r).toMatchObject({ ok: true, cs: { baseVersion: head.version } });
    if (!r.ok) return;
    const applied = applyChangeSet(head, r.cs);
    expect(applied.ok && applied.model.elements[a.id]?.label).toBe('A2');
    expect(applied.ok && applied.model.elements[b.id]?.label).toBe('B2');
  });

  it('réussit sur le même élément quand les champs sont disjoints', () => {
    const { head, diff } = intervene([{ op: 'update', id: a.id, set: { label: 'A2' } }]);
    const r = rebase(cs([{ op: 'update', id: a.id, set: { description: 'd' } }]), [diff], head);
    expect(r.ok).toBe(true);
  });

  it.each([
    [
      'même champ modifié',
      [{ op: 'update', id: 'A', set: { label: 'X' } }],
      [{ op: 'update', id: 'A', set: { label: 'Y' } }],
      ['A'],
    ],
    [
      'élément retiré puis modifié',
      [{ op: 'remove', id: 'B' }],
      [{ op: 'update', id: 'B', set: { label: 'Y' } }],
      ['B'],
    ],
    [
      'élément modifié puis retiré',
      [{ op: 'update', id: 'A', set: { label: 'X' } }],
      [{ op: 'remove', id: 'A' }],
      ['A'],
    ],
    [
      'statut changé des deux côtés',
      [{ op: 'set_status', id: 'A', status: 'validated' }],
      [{ op: 'set_status', id: 'A', status: 'confirmed' }],
      ['A'],
    ],
  ] as const)('échoue : %s', (_n, theirs, mine, expected) => {
    const ids: Record<string, string> = { A: a.id, B: b.id };
    const sub = (ops: readonly unknown[]): ModelOp[] =>
      JSON.parse(JSON.stringify(ops), (_k, v) =>
        typeof v === 'string' && ids[v] ? ids[v] : v,
      ) as ModelOp[];
    // L'autre utilisateur agit comme validateur pour les cas de statut.
    const r1 = applyChangeSet(base, cs(sub(theirs)), { actor: 'validator', submissionId: 's' });
    if (!r1.ok) throw new Error(JSON.stringify(r1.errors));
    const r = rebase(cs(sub(mine)), [r1.diff], r1.model);
    expect(r).toEqual({ ok: false, conflicts: expected.map((x) => ids[x] as string).sort() });
  });

  it('échoue quand un ajout référence un élément retiré entre-temps', () => {
    const { head, diff } = intervene([{ op: 'remove', id: a.id }]);
    const act = buildActivity({ responsibleActorId: a.id, code: '' });
    const r = rebase(cs([{ op: 'add', element: { ...act, id: 'tmp:1' } }]), [diff], head);
    expect(r).toEqual({ ok: false, conflicts: [a.id] });
  });

  it('une disposition n’est jamais en conflit', () => {
    const { head, diff } = intervene([{ op: 'update', id: a.id, set: { label: 'A2' } }]);
    const r = rebase(
      cs([{ op: 'set_layout', diagram: 'L0', positions: { [a.id]: { x: 0, y: 0, w: 1, h: 1 } } }]),
      [diff],
      head,
    );
    expect(r.ok).toBe(true);
  });

  it('cumule les diffs de plusieurs versions intercalées', () => {
    const { head: h2, diff: d1 } = intervene([{ op: 'update', id: a.id, set: { label: 'A2' } }]);
    const step2 = applyChangeSet(h2, cs([{ op: 'update', id: b.id, set: { label: 'B2' } }], 2));
    if (!step2.ok) throw new Error('inattendu');
    const r = rebase(
      cs([{ op: 'update', id: b.id, set: { label: 'B3' } }]),
      [d1, step2.diff],
      step2.model,
    );
    expect(r).toEqual({ ok: false, conflicts: [b.id] });
  });
});
