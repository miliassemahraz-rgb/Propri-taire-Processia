import { describe, expect, it } from 'vitest';
import type { BusinessModel } from '../schema/business-model.js';
import type { Element } from '../schema/element.js';
import { CURRENT_SCHEMA_VERSION } from '../migrations/index.js';
import { applyChangeSet } from './apply.js';
import { planHypothesisRejection } from './reject.js';

const AT = '2026-11-27T10:00:00.000Z';
const id = (n: number): string => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const meta = { createdInVersion: 1, updatedInVersion: 1 };
const hyp = { value: 'hypothesis' as const };
const conf = { value: 'confirmed' as const };
const prov = {
  origin: 'ai_knowledge' as const,
  refs: [],
  rationale: 'r',
  author: { type: 'ai' as const },
  at: AT,
};

const activity = (
  n: number,
  code: string,
  level: 'macro' | 'process',
  parent?: number,
): Element => ({
  id: id(n),
  kind: 'activity',
  code,
  label: code,
  level,
  ...(parent === undefined ? {} : { parentId: id(parent) }),
  raci: [],
  inputs: [],
  outputs: [],
  toolIds: [],
  ruleIds: [],
  execution: 'manual',
  provenance: prov,
  status: conf,
  meta,
});

function build(extra: Element[] = []): BusinessModel {
  const els: Element[] = [
    activity(1, 'P01', 'macro'),
    activity(2, 'P01.1', 'process', 1),
    {
      id: id(3),
      kind: 'event',
      code: 'EVT-01',
      label: 'Début',
      containerId: id(2),
      position: 'start',
      trigger: 'none',
      provenance: prov,
      status: hyp,
      meta,
    },
    {
      id: id(4),
      kind: 'event',
      code: 'EVT-02',
      label: 'Fin',
      containerId: id(2),
      position: 'end',
      trigger: 'none',
      provenance: prov,
      status: hyp,
      meta,
    },
    {
      id: id(5),
      kind: 'sequence_flow',
      code: 'SEQ-01',
      label: 'Début → Fin',
      containerId: id(2),
      fromId: id(3),
      toId: id(4),
      provenance: prov,
      status: hyp,
      meta,
    },
    ...extra,
  ];
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    missionId: id(99),
    version: 1,
    elements: Object.fromEntries(els.map((e) => [e.id, e])),
    rejectedHypotheses: [],
    layout: {},
  };
}

const actor: Element = {
  id: id(7),
  kind: 'actor',
  code: 'ACT-01',
  label: 'A',
  category: 'internal',
  responsibilities: [],
  provenance: prov,
  status: conf,
  meta,
};
const infoFlow = (status: Element['status']): Element => ({
  id: id(6),
  kind: 'information_flow',
  code: 'FLX-01',
  label: 'Flux',
  fromActorId: id(7),
  toActorId: id(7),
  dataObjectIds: [],
  channel: 'email',
  activityId: id(3),
  provenance: prov,
  status,
  meta,
});

describe('planHypothesisRejection', () => {
  it('rejette en cascade les flux qui ne survivent pas à leur nœud', () => {
    const model = build();
    const plan = planHypothesisRejection(model, [id(3)]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect([...plan.reject].sort()).toEqual([id(3), id(5)].sort());
    expect(plan.updates).toEqual([]);
    const res = applyChangeSet(
      model,
      {
        baseVersion: 1,
        cause: 'hypothesis_decision',
        summary: 'rejet',
        ops: plan.reject.map((x) => ({ op: 'reject_hypothesis' as const, id: x })),
      },
      { at: AT },
    );
    expect(res.ok).toBe(true);
  });

  it('nettoie une référence facultative et refuse de toucher un élément décidé', () => {
    const plan = planHypothesisRejection(build([infoFlow(hyp), actor]), [id(3)]);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.updates).toEqual([{ id: id(6), set: {}, unset: ['activityId'] }]);
    }
    const blocked = planHypothesisRejection(build([infoFlow(conf), actor]), [id(3)]);
    expect(blocked.ok).toBe(false);
  });
});
