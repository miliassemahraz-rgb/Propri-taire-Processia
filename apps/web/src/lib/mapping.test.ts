import { buildCompleteModel, buildOutline, listDiagrams } from '@processia/model';
import { describe, expect, it } from 'vitest';
import {
  CARD_W,
  describeElement,
  indicatorValue,
  layoutSimple,
  markersByElement,
  nextSteps,
} from './mapping';

describe('visionneuse de cartographie : fonctions pures', () => {
  const model = buildCompleteModel();

  it('dispose chaque étape une seule fois, dans son couloir, sans recouvrement', () => {
    for (const diagram of listDiagrams(model)) {
      const outline = buildOutline(model, diagram);
      if (outline === undefined) throw new Error(diagram);
      const layout = layoutSimple(outline);
      expect(Object.keys(layout.placements).sort()).toEqual(outline.nodes.map((n) => n.id).sort());
      const seen = new Set<string>();
      for (const p of Object.values(layout.placements)) {
        const key = `${p.x}:${p.y}`;
        expect(seen.has(key), `${diagram} ${key}`).toBe(false);
        seen.add(key);
        expect(p.x + CARD_W).toBeLessThanOrEqual(layout.width);
      }
      for (const arrow of layout.arrows) expect(arrow.path.startsWith('M ')).toBe(true);
    }
  });

  it('donne les suites d’une étape dans l’ordre de lecture', () => {
    const outline = buildOutline(model, 'L0');
    const first = outline?.nodes[0];
    if (outline === undefined || first === undefined) throw new Error('plan vide');
    const next = nextSteps(outline, first.id);
    expect(next.map((n) => n.node.number)).toEqual(
      [...next.map((n) => n.node.number)].sort((a, b) => a - b),
    );
  });

  it('décrit un élément : code, statut, responsable, sources', () => {
    const activity = Object.values(model.elements).find((e) => e.kind === 'activity');
    const detail = describeElement(model, activity?.id ?? '');
    expect(detail?.code).toBe(activity?.code);
    expect(detail?.status).toBe(activity?.status.value);
    expect(describeElement(model, 'inconnu')).toBeNull();
  });

  it('marque les hypothèses', () => {
    const markers = markersByElement(model);
    for (const el of Object.values(model.elements)) {
      expect(markers.get(el.id)?.hypothesis ?? false).toBe(el.status.value === 'hypothesis');
    }
  });

  it('écrit les valeurs d’indicateur', () => {
    expect(indicatorValue({ exact: 7 }, 'jours')).toBe('7 jours');
    expect(indicatorValue({ min: 3, max: 5 }, 'jours')).toBe('3 – 5 jours');
    expect(indicatorValue({ min: 3 }, 'jours')).toBe('≥ 3 jours');
  });
});
