import { describe, expect, it } from 'vitest';
import { buildCompleteModel } from '../testing/index.js';
import { buildOutline, diagramTrail, listDiagrams, parseDiagramId } from './outline.js';

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
