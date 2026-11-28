import { describe, expect, it } from 'vitest';
import {
  buildActivity,
  buildEvent,
  buildIndicator,
  buildModel,
  buildRule,
  buildSequenceFlow,
  buildStatus,
  resetTestIds,
} from '../testing/index.js';
import { applyChangeSet } from './apply.js';
import { planRemoval } from './removal.js';

function setup() {
  resetTestIds();
  const macro = buildActivity({ level: 'macro', label: 'Macro' });
  const process = buildActivity({ level: 'process', parentId: macro.id, label: 'Process' });
  const taskA = buildActivity({
    level: 'task',
    parentId: process.id,
    label: 'A',
    status: buildStatus({ value: 'confirmed' }),
  });
  const taskB = buildActivity({
    level: 'task',
    parentId: process.id,
    label: 'B',
    status: buildStatus({ value: 'hypothesis' }),
  });
  const step = buildActivity({ level: 'step', parentId: taskA.id, label: 'Étape de A' });
  const rule = buildRule({ appliesTo: [taskA.id, taskB.id] });
  const indicator = buildIndicator({ targetId: taskA.id });
  const start = buildEvent({ containerId: process.id, position: 'start' });
  const flow = buildSequenceFlow({ containerId: process.id, fromId: start.id, toId: taskA.id });
  const model = buildModel([macro, process, taskA, taskB, step, rule, indicator, start, flow]);
  return { model, taskA, taskB, step, rule, indicator, flow };
}

describe('planRemoval', () => {
  it('retire ce qui ne survit pas (niveau 3, indicateur, flux) et nettoie les références facultatives', () => {
    const { model, taskA, taskB, step, rule, indicator, flow } = setup();
    const plan = planRemoval(model, [taskA.id]);
    expect(plan.removed.sort()).toEqual([taskA.id, step.id, indicator.id, flow.id].sort());
    const update = plan.ops.find((op) => op.op === 'update' && op.id === rule.id);
    expect(update).toMatchObject({ set: { appliesTo: [taskB.id] } });
    const res = applyChangeSet(model, {
      baseVersion: 1,
      ops: plan.ops,
      cause: 'dialogue_edit',
      summary: 's',
    });
    expect(res.ok).toBe(true);
  });

  it('une hypothèse est rejetée, un élément décidé est retiré', () => {
    const { model, taskA, taskB } = setup();
    const plan = planRemoval(model, [taskA.id, taskB.id], { reason: 'test' });
    const kinds = new Map<string, string>();
    for (const op of plan.ops) {
      if (op.op === 'remove' || op.op === 'reject_hypothesis') kinds.set(op.id, op.op);
    }
    expect(kinds.get(taskA.id)).toBe('remove');
    expect(kinds.get(taskB.id)).toBe('reject_hypothesis');
  });
});
