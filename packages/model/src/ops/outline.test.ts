import { describe, expect, it } from 'vitest';
import {
  buildActivity,
  buildActor,
  buildCompleteModel,
  buildEvent,
  buildInformationFlow,
  buildModel,
  buildSequenceFlow,
  resetTestIds,
} from '../testing/index.js';
import {
  buildOutline,
  diagramOfElement,
  diagramTrail,
  listDiagrams,
  parseDiagramId,
} from './outline.js';

describe('plan structuré d’un diagramme', () => {
  const model = buildCompleteModel();

  it('analyse les identifiants de diagramme', () => {
    expect(parseDiagramId('L0')).toEqual({ level: 'L0' });
    expect(parseDiagramId('L2:abc')).toEqual({ level: 'L2', anchorId: 'abc' });
    expect(parseDiagramId('X')).toBeUndefined();
  });

  it('chaque diagramme a un plan, aux rangs consécutifs, et un fil d’Ariane qui commence à L0', () => {
    for (const diagram of listDiagrams(model)) {
      const outline = buildOutline(model, diagram);
      expect(outline, diagram).toBeDefined();
      expect(outline?.nodes.map((n) => n.number)).toEqual(
        (outline?.nodes ?? []).map((_, i) => i + 1),
      );
      const trail = diagramTrail(model, diagram);
      expect(trail[0]).toBe('L0');
      expect(trail[trail.length - 1]).toBe(diagram);
    }
  });

  it('un niveau mène au suivant par drillTo, et un diagramme inconnu n’a pas de plan', () => {
    const l0 = buildOutline(model, 'L0');
    const macro = l0?.nodes.find((n) => n.kind === 'macro');
    expect(macro?.drillTo).toBe(`L1:${macro?.id}`);
    expect(buildOutline(model, 'L1:inconnu')).toBeUndefined();
    expect(diagramTrail(model, 'L2:inconnu')).toEqual([]);
  });
});

describe('diagramOfElement', () => {
  it('place chaque élément dessiné dans un diagramme qui le contient', () => {
    resetTestIds();
    const macro = buildActivity({ level: 'macro', label: 'Macro' });
    const process = buildActivity({ level: 'process', parentId: macro.id });
    const task = buildActivity({ level: 'task', parentId: process.id });
    const step = buildActivity({ level: 'step', parentId: task.id });
    const start = buildEvent({ containerId: process.id, position: 'start' });
    const end = buildEvent({ containerId: process.id, position: 'end' });
    const flow = buildSequenceFlow({ containerId: process.id, fromId: start.id, toId: task.id });
    const flow2 = buildSequenceFlow({ containerId: process.id, fromId: task.id, toId: end.id });
    const stepStart = buildEvent({ containerId: task.id, position: 'start' });
    const info = buildInformationFlow({ activityId: step.id });
    const model = buildModel([
      macro,
      process,
      task,
      step,
      start,
      end,
      flow,
      flow2,
      stepStart,
      info,
    ]);
    expect(diagramOfElement(model, macro.id)).toBe('L0');
    expect(diagramOfElement(model, process.id)).toBe(`L1:${macro.id}`);
    expect(diagramOfElement(model, task.id)).toBe(`L2:${process.id}`);
    expect(diagramOfElement(model, step.id)).toBe(`L3:${task.id}`);
    expect(diagramOfElement(model, start.id)).toBe(`L2:${process.id}`);
    expect(diagramOfElement(model, flow.id)).toBe(`L2:${process.id}`);
    expect(diagramOfElement(model, stepStart.id)).toBe(`L3:${task.id}`);
    expect(diagramOfElement(model, info.id)).toBe(`L3:${task.id}`);
    for (const id of [process.id, task.id, step.id, start.id, stepStart.id]) {
      const diagram = diagramOfElement(model, id) as string;
      expect(buildOutline(model, diagram)?.nodes.map((n) => n.id)).toContain(id);
    }
  });

  it('ne place ni un acteur ni un élément inconnu', () => {
    resetTestIds();
    const actor = buildActor();
    const model = buildModel([actor]);
    expect(diagramOfElement(model, actor.id)).toBeUndefined();
    expect(diagramOfElement(model, 'inconnu')).toBeUndefined();
  });
});
