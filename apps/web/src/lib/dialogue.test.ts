import {
  buildActivity,
  buildActor,
  buildEvent,
  buildModel,
  buildSequenceFlow,
  resetTestIds,
  type BusinessModel,
  planRemoval,
  type ChangeSet,
} from '@processia/model';
import { describe, expect, it } from 'vitest';
import { buildPreview, diagramToOpen } from './dialogue';

function setup() {
  resetTestIds();
  const chef = buildActor({ label: 'Chef de mission' });
  const macro = buildActivity({ level: 'macro', label: 'Révision' });
  const process = buildActivity({ level: 'process', parentId: macro.id, label: 'Contrôle' });
  const a = buildActivity({ level: 'task', parentId: process.id, label: 'A', order: 1 });
  const start = buildEvent({ containerId: process.id, position: 'start', label: 'Début' });
  const end = buildEvent({ containerId: process.id, position: 'end', label: 'Fin' });
  const f1 = buildSequenceFlow({ containerId: process.id, fromId: start.id, toId: a.id });
  const f2 = buildSequenceFlow({ containerId: process.id, fromId: a.id, toId: end.id });
  const model = buildModel([chef, macro, process, a, start, end, f1, f2], { version: 3 });
  return { model, chef, process, a, end, f1, f2 };
}

const insertAfter = (model: BusinessModel, ids: ReturnType<typeof setup>): ChangeSet => ({
  baseVersion: model.version,
  cause: 'dialogue_edit',
  summary: 'Dialogue : ajoute',
  ops: [
    {
      op: 'add',
      element: {
        id: 'tmp:1',
        code: '',
        kind: 'activity',
        label: 'Validation',
        level: 'task',
        parentId: ids.process.id,
        responsibleActorId: ids.chef.id,
        raci: [{ actorId: ids.chef.id, role: 'R' }],
        inputs: [],
        outputs: [],
        toolIds: [],
        ruleIds: [],
        execution: 'manual',
        provenance: {
          origin: 'consultant',
          refs: [],
          author: { type: 'user' },
          at: '2026-11-27T10:00:00.000Z',
        },
        status: { value: 'confirmed' },
        meta: { createdInVersion: 0, updatedInVersion: 0 },
      },
    },
    { op: 'update', id: ids.f2.id, set: { toId: 'tmp:1' } },
    {
      op: 'add',
      element: {
        id: 'tmp:2',
        code: '',
        kind: 'sequence_flow',
        label: 'Validation → Fin',
        containerId: ids.process.id,
        fromId: 'tmp:1',
        toId: ids.end.id,
        provenance: {
          origin: 'consultant',
          refs: [],
          author: { type: 'user' },
          at: '2026-11-27T10:00:00.000Z',
        },
        status: { value: 'confirmed' },
        meta: { createdInVersion: 0, updatedInVersion: 0 },
      },
    },
  ],
});

describe('buildPreview', () => {
  it('marque l’ajout en vert, la suite modifiée en orange, et liste les changements', () => {
    const ids = setup();
    const preview = buildPreview({ id: 'p1', changeSet: insertAfter(ids.model, ids) }, ids.model);
    expect(preview).not.toBeNull();
    const p = preview as NonNullable<typeof preview>;
    const added = [...p.afterChanges].filter(([, kind]) => kind === 'added');
    expect(added).toHaveLength(1);
    expect(p.after.elements[added[0]?.[0] as string]?.label).toBe('Validation');
    // L'étape A voit sa suite changer : modifiée dans « après » et dans « avant ».
    expect(p.afterChanges.get(ids.a.id)).toBe('modified');
    expect(p.beforeChanges.get(ids.a.id)).toBe('modified');
    expect(p.entries.map((e) => [e.change, e.kind])).toEqual([
      ['added', 'activity'],
      ['added', 'sequence_flow'],
      ['modified', 'sequence_flow'],
    ]);
    expect(p.entries.find((e) => e.change === 'modified')?.route).toBe('A → Validation');
    expect(p.diagrams).toEqual([`L2:${ids.process.id}`]);
    // Le modèle de départ n'est pas modifié.
    expect(ids.model.version).toBe(3);
    expect(Object.keys(ids.model.elements)).toHaveLength(8);
  });

  it('une suppression est marquée en rouge dans « avant », la suite précédente en orange', () => {
    const ids = setup();
    const work: BusinessModel = {
      ...ids.model,
      elements: { ...ids.model.elements, [ids.f1.id]: { ...ids.f1, toId: ids.end.id } },
    };
    const changeSet: ChangeSet = {
      baseVersion: 3,
      cause: 'dialogue_edit',
      summary: 'Dialogue : supprime',
      ops: [
        { op: 'update', id: ids.f1.id, set: { toId: ids.end.id } },
        ...planRemoval(work, [ids.a.id]).ops,
      ],
    };
    const p = buildPreview({ id: 'p2', changeSet }, ids.model) as NonNullable<
      ReturnType<typeof buildPreview>
    >;
    expect(p.beforeChanges.get(ids.a.id)).toBe('removed');
    expect(p.afterChanges.has(ids.a.id)).toBe(false);
    expect(p.entries.filter((e) => e.change === 'removed').map((e) => e.kind)).toContain(
      'activity',
    );
  });

  it('une proposition d’une autre version n’a pas d’aperçu', () => {
    const ids = setup();
    const changeSet = { ...insertAfter(ids.model, ids), baseVersion: 2 };
    expect(buildPreview({ id: 'p3', changeSet }, ids.model)).toBeNull();
  });

  it('propose d’ouvrir le niveau modifié quand il n’est pas affiché', () => {
    const ids = setup();
    const preview = buildPreview(
      { id: 'p1', changeSet: insertAfter(ids.model, ids) },
      ids.model,
    ) as NonNullable<ReturnType<typeof buildPreview>>;
    expect(diagramToOpen(preview, 'L0')).toBe(`L2:${ids.process.id}`);
    expect(diagramToOpen(preview, `L2:${ids.process.id}`)).toBeNull();
  });
});
