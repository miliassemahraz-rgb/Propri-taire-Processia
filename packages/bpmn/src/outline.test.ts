import { describe, expect, it } from 'vitest';
import type { ModdleElement } from 'bpmn-moddle';
import { buildOutline, listDiagrams, type BusinessModel } from '@processia/model';
import { createModdle, toBpmn } from './index.js';
import { buildCompleteModel, buildMinimalModel, buildRichModel } from './test-support.js';

const models: [string, () => BusinessModel][] = [
  ['modèle minimal', buildMinimalModel],
  ['modèle complet', buildCompleteModel],
  ['modèle riche', buildRichModel],
];

const STEP_KINDS = new Set(['activity', 'event', 'gateway']);

/** Éléments du modèle (étapes, événements, passerelles) qui ont une forme dans le BPMN. */
async function bpmnStepIds(
  model: BusinessModel,
  xml: string,
  anchorId?: string,
): Promise<string[]> {
  const { rootElement } = await createModdle().fromXML(xml);
  const ids: string[] = [];
  for (const d of rootElement['diagrams'] as ModdleElement[]) {
    for (const pe of (d['plane'] as ModdleElement)['planeElement'] as ModdleElement[]) {
      if (pe.$type !== 'bpmndi:BPMNShape') continue;
      const id = pe.get('processia:elementId') as string | undefined;
      if (id === undefined || id === anchorId) continue;
      if (STEP_KINDS.has(model.elements[id]?.kind ?? '')) ids.push(id);
    }
  }
  return ids.sort();
}

describe('@processia/bpmn : cohérence du plan structuré (vue simplifiée, alternative textuelle)', () => {
  for (const [name, build] of models) {
    it(`${name} : le plan de chaque diagramme liste les mêmes étapes que le BPMN`, async () => {
      const model = build();
      for (const diagram of listDiagrams(model)) {
        const outline = buildOutline(model, diagram);
        expect(outline, diagram).toBeDefined();
        const { xml } = await toBpmn(model, diagram);
        const fromBpmn = await bpmnStepIds(model, xml, outline?.anchorId);
        const fromOutline = (outline?.nodes ?? []).map((n) => n.id).sort();
        expect(fromOutline, diagram).toEqual(fromBpmn);
        // Rangs consécutifs, sans doublon ; chaque nœud appartient à un groupe.
        expect((outline?.nodes ?? []).map((n) => n.number).sort((a, b) => a - b)).toEqual(
          (outline?.nodes ?? []).map((_, i) => i + 1),
        );
        const grouped = (outline?.groups ?? []).flatMap((g) => g.nodeIds).sort();
        expect(grouped, diagram).toEqual(fromOutline);
      }
    });

    it(`${name} : les flux du plan sont ceux du BPMN`, async () => {
      const model = build();
      for (const diagram of listDiagrams(model)) {
        const outline = buildOutline(model, diagram);
        const { xml } = await toBpmn(model, diagram);
        const { rootElement } = await createModdle().fromXML(xml);
        const idOf = new Map<string, string>();
        const flows = new Set<string>();
        for (const d of rootElement['diagrams'] as ModdleElement[]) {
          for (const pe of (d['plane'] as ModdleElement)['planeElement'] as ModdleElement[]) {
            const ref = pe['bpmnElement'] as ModdleElement;
            const id = pe.get('processia:elementId') as string | undefined;
            if (pe.$type === 'bpmndi:BPMNShape' && id !== undefined) idOf.set(ref.id as string, id);
          }
        }
        for (const d of rootElement['diagrams'] as ModdleElement[]) {
          for (const pe of (d['plane'] as ModdleElement)['planeElement'] as ModdleElement[]) {
            const ref = pe['bpmnElement'] as ModdleElement;
            if (pe.$type !== 'bpmndi:BPMNEdge' || ref.$type !== 'bpmn:SequenceFlow') continue;
            const from = idOf.get((ref['sourceRef'] as ModdleElement).id as string);
            const to = idOf.get((ref['targetRef'] as ModdleElement).id as string);
            flows.add(`${from}>${to}`);
          }
        }
        const sequence = (outline?.edges ?? []).filter(
          (e) => e.nature === undefined || e.nature === 'sequence',
        );
        expect(new Set(sequence.map((e) => `${e.fromId}>${e.toId}`)), diagram).toEqual(flows);
      }
    });
  }
});
