import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BusinessModel } from '../schema/business-model.js';
import type { Element } from '../schema/element.js';
import {
  buildActivity,
  buildActor,
  buildCompleteModel,
  buildDataField,
  buildDataObject,
  buildDiscrepancy,
  buildGlossaryTerm,
  buildMinimalModel,
  buildModel,
  buildProvenance,
  buildSourceRef,
  buildStatus,
  resetTestIds,
} from '../testing/index.js';
import { parseModel } from '../parse.js';
import { danglingReferences } from './refs.js';
import { deliverableView, raciMatrix } from './views.js';

function hasHypothesis(m: BusinessModel): boolean {
  if (m.rejectedHypotheses.length > 0) return true;
  return Object.values(m.elements).some(
    (e) =>
      e.status.value === 'hypothesis' ||
      (e.kind === 'data_object' && e.fields.some((f) => f.status.value === 'hypothesis')) ||
      (e.kind === 'discrepancy' && e.state === 'open') ||
      (e.kind === 'optimisation' &&
        e.changeSet.ops.some((o) => o.op === 'add' && o.element.status.value === 'hypothesis')),
  );
}

/** Rend un élément valide dans le statut demandé (source ou justification ajoutées au besoin). */
function withStatus(
  e: Element,
  value: 'extracted' | 'hypothesis' | 'confirmed' | 'validated',
): Element {
  const provenance =
    value === 'extracted'
      ? buildProvenance({ origin: 'document', refs: [buildSourceRef()], author: { type: 'ai' } })
      : value === 'hypothesis'
        ? buildProvenance({
            origin: 'ai_knowledge',
            rationale: 'Parce que',
            author: { type: 'ai' },
          })
        : e.provenance;
  return { ...e, provenance, status: buildStatus({ value }) } as Element;
}

describe('deliverableView', () => {
  beforeEach(() => resetTestIds());

  it('retire hypothèses, écarts ouverts et archive des hypothèses rejetées du modèle minimal', () => {
    const m = buildMinimalModel();
    expect(hasHypothesis(m)).toBe(true);
    const v = deliverableView(m);
    expect(hasHypothesis(v)).toBe(false);
    expect(v.version).toBe(m.version);
    expect(danglingReferences(v)).toEqual([]);
    expect(parseModel(JSON.parse(JSON.stringify(v))).ok).toBe(true);
  });

  it('garde les éléments « Extrait » non confirmés [PO-11]', () => {
    const v = deliverableView(buildMinimalModel());
    expect(Object.values(v.elements).some((e) => e.status.value === 'extracted')).toBe(true);
  });

  it('un écart résolu est conservé, un écart ouvert est retiré', () => {
    const open = buildDiscrepancy();
    const resolved = buildDiscrepancy({
      state: 'resolved',
      resolution: { note: 'ok', by: 'u', at: '2026-01-01T00:00:00.000Z' },
    });
    const v = deliverableView(buildModel([open, resolved]));
    expect(Object.keys(v.elements)).toEqual([resolved.id]);
  });

  it('retire en cascade ce qui dépend d’une hypothèse (parent, flux, champ)', () => {
    const complete = buildCompleteModel();
    const process = Object.values(complete.elements).find(
      (e) => e.kind === 'activity' && e.level === 'process',
    ) as Element;
    const hyp = withStatus(process, 'hypothesis');
    const v = deliverableView({
      ...complete,
      elements: { ...complete.elements, [process.id]: hyp },
    });
    expect(v.elements[process.id]).toBeUndefined();
    // tâche, événements, passerelle, flux de séquence et indicateurs du processus ont disparu
    expect(
      Object.values(v.elements).filter((e) => e.kind === 'event' || e.kind === 'sequence_flow'),
    ).toEqual([]);
    expect(danglingReferences(v)).toEqual([]);
  });

  it('retire un champ de donnée hypothétique et ses références', () => {
    const f = buildDataField({
      status: buildStatus({ value: 'hypothesis' }),
      provenance: buildProvenance({ origin: 'ai_knowledge', rationale: 'r' }),
    });
    const keep = buildDataField();
    const d = buildDataObject({ fields: [f, keep] });
    const other = buildDataObject({
      fields: [buildDataField({ type: 'reference', referenceObjectId: f.id })],
    });
    const v = deliverableView(buildModel([d, other]));
    expect((v.elements[d.id] as typeof d).fields).toEqual([keep]);
    expect(danglingReferences(v)).toEqual([]);
  });

  it('ne modifie pas son entrée', () => {
    const m = buildMinimalModel();
    const copy = structuredClone(m);
    deliverableView(m);
    expect(m).toEqual(copy);
  });

  it('propriété : jamais d’hypothèse, références intactes, idempotente', () => {
    const base = buildCompleteModel();
    const ids = Object.keys(base.elements);
    const statuses = fc.constantFrom('extracted', 'hypothesis', 'confirmed', 'validated' as const);
    fc.assert(
      fc.property(
        fc.array(statuses, { minLength: ids.length, maxLength: ids.length }),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        (picks, extras) => {
          const elements: Record<string, Element> = {};
          ids.forEach((id, i) => {
            elements[id] = withStatus(base.elements[id] as Element, picks[i] as 'extracted');
          });
          const extra: Element[] = [];
          if (extras[0]) extra.push(buildDiscrepancy({ elementIds: [ids[0] as string] }));
          if (extras[1]) extra.push(buildGlossaryTerm());
          if (extras[2]) {
            extra.push(
              buildDataObject({
                fields: [
                  buildDataField({
                    status: buildStatus({ value: 'hypothesis' }),
                    provenance: buildProvenance({ origin: 'ai_knowledge', rationale: 'r' }),
                  }),
                ],
              }),
            );
          }
          for (const e of extra) elements[e.id] = e;
          const rejected = withStatus(buildActor(), 'hypothesis');
          const model: BusinessModel = {
            ...base,
            elements,
            rejectedHypotheses: [{ element: rejected, by: 'u', at: '2026-01-01T00:00:00.000Z' }],
          };
          const v = deliverableView(model);
          expect(hasHypothesis(v)).toBe(false);
          expect(danglingReferences(v)).toEqual([]);
          expect(deliverableView(v)).toEqual(v);
          expect(Object.keys(v.elements).every((id) => id in model.elements)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('raciMatrix', () => {
  beforeEach(() => resetTestIds());

  it('liste les rôles par activité et par acteur ; le responsable compte pour R', () => {
    const m = buildCompleteModel();
    const matrix = raciMatrix(m);
    const process = matrix.rows.find((r) => r.level === 'process');
    const accountant = matrix.actors.find((a) => a.label === 'Comptable');
    const client = matrix.actors.find((a) => a.label === 'Client');
    expect(process?.roles[accountant?.id as string]).toEqual(['R']);
    expect(process?.roles[client?.id as string]).toEqual(['I']);
    const task = matrix.rows.find((r) => r.level === 'task');
    expect(task?.roles[accountant?.id as string]).toEqual(['R']);
  });

  it('une portée restreint aux descendantes ; une feuille se représente elle-même', () => {
    const m = buildCompleteModel();
    const macro = Object.values(m.elements).find(
      (e) => e.kind === 'activity' && e.level === 'macro',
    ) as Element;
    const task = Object.values(m.elements).find(
      (e) => e.kind === 'activity' && e.level === 'task',
    ) as Element;
    expect(
      raciMatrix(m, macro.id)
        .rows.map((r) => r.level)
        .sort(),
    ).toEqual(['process', 'task']);
    expect(raciMatrix(m, task.id).rows.map((r) => r.activityId)).toEqual([task.id]);
  });

  it('fusionne les rôles multiples dans l’ordre R, A, C, I et ne garde que les acteurs présents', () => {
    const a = buildActor();
    const unused = buildActor();
    const act = buildActivity({
      level: 'macro',
      raci: [
        { actorId: a.id, role: 'I' },
        { actorId: a.id, role: 'A' },
      ],
      responsibleActorId: a.id,
    });
    const r = raciMatrix(buildModel([a, unused, act]));
    expect(r.actors.map((x) => x.id)).toEqual([a.id]);
    expect(r.rows[0]?.roles[a.id]).toEqual(['R', 'A', 'I']);
  });

  it('un modèle sans activité donne une matrice vide', () => {
    expect(raciMatrix(buildModel([]))).toEqual({ actors: [], rows: [] });
  });
});
