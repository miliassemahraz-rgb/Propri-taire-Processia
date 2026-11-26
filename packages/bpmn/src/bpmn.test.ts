import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ModdleElement } from 'bpmn-moddle';
import type { BusinessModel, Element } from '@processia/model';
import { applyChangeSet, type ChangeSet } from '@processia/model';
import {
  COMBINED_FILE_NAME,
  compact,
  createModdle,
  diagramFileName,
  elementIdFromBpmnId,
  exportBpmnZip,
  listDiagrams,
  toBpmn,
  toBpmnCombined,
} from './index.js';
import {
  addTaskToRichModel,
  buildCompleteModel,
  buildMinimalModel,
  buildRichModel,
} from './test-support.js';

const require = createRequire(import.meta.url);
const XSD = join(
  dirname(require.resolve('bpmn-moddle/package.json')),
  'resources/bpmn/xsd/BPMN20.xsd',
);
const hasXmllint = spawnSync('xmllint', ['--version']).status === 0;

const models: [string, () => BusinessModel][] = [
  ['modèle minimal', buildMinimalModel],
  ['modèle complet', buildCompleteModel],
  ['modèle riche', buildRichModel],
];

interface Shape {
  bpmnId: string;
  type: string;
  elementId?: string;
  box: { x: number; y: number; w: number; h: number };
  expanded?: boolean;
}
interface Parsed {
  warnings: string[];
  shapes: Shape[];
  edges: { bpmnId: string; elementId?: string; points: number }[];
  semantic: ModdleElement[];
}

async function parse(xml: string, diagramIndex?: number): Promise<Parsed> {
  const { rootElement, warnings } = await createModdle().fromXML(xml);
  const diagrams = rootElement['diagrams'] as ModdleElement[];
  const planes = diagramIndex === undefined ? diagrams : [diagrams[diagramIndex] as ModdleElement];
  const shapes: Shape[] = [];
  const edges: Parsed['edges'] = [];
  for (const d of planes) {
    for (const pe of (d['plane'] as ModdleElement)['planeElement'] as ModdleElement[]) {
      const ref = pe['bpmnElement'] as ModdleElement;
      const elementId = pe.get('processia:elementId') as string | undefined;
      if (pe.$type === 'bpmndi:BPMNShape') {
        const b = pe['bounds'] as Record<string, number>;
        shapes.push({
          bpmnId: ref.id as string,
          type: ref.$type,
          ...(elementId !== undefined && { elementId }),
          box: {
            x: b['x'] as number,
            y: b['y'] as number,
            w: b['width'] as number,
            h: b['height'] as number,
          },
          ...(pe['isExpanded'] === true && { expanded: true }),
        });
      } else {
        edges.push({
          bpmnId: ref.id as string,
          ...(elementId !== undefined && { elementId }),
          points: (pe['waypoint'] as unknown[]).length,
        });
      }
    }
  }
  const semantic: ModdleElement[] = [];
  const walk = (el: ModdleElement): void => {
    semantic.push(el);
    for (const key of [
      'flowElements',
      'artifacts',
      'participants',
      'messageFlows',
      'rootElements',
    ]) {
      for (const child of (el[key] as ModdleElement[] | undefined) ?? []) walk(child);
    }
  };
  walk(rootElement);
  return { warnings: warnings.map((w) => w.message), shapes, edges, semantic };
}

describe('@processia/bpmn : validité', () => {
  for (const [name, build] of models) {
    it.skipIf(!hasXmllint)(
      `${name} : chaque diagramme et le fichier combiné valident le XSD BPMN 2.0 de l'OMG`,
      async () => {
        const model = build();
        const dir = mkdtempSync(join(tmpdir(), 'bpmn-xsd-'));
        try {
          const inputs = [
            ...(await Promise.all(
              listDiagrams(model).map(async (d) => [d, (await toBpmn(model, d)).xml] as const),
            )),
            ['combiné', (await toBpmnCombined(model)).xml] as const,
          ];
          for (const [d, xml] of inputs) {
            const file = join(dir, `${d.replace(/[^a-zA-Z0-9]/g, '_')}.bpmn`);
            writeFileSync(file, xml);
            const r = spawnSync('xmllint', ['--noout', '--schema', XSD, file], {
              encoding: 'utf8',
            });
            expect(r.stderr, `${d}\n${r.stderr}`).toContain('validates');
            expect(r.status, `${d}\n${r.stderr}`).toBe(0);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    it(`${name} : bpmn-moddle relit chaque diagramme sans avertissement ni élément inconnu`, async () => {
      const model = build();
      for (const d of listDiagrams(model)) {
        const { xml } = await toBpmn(model, d);
        const parsed = await parse(xml);
        expect(parsed.warnings, d).toEqual([]);
        expect(
          parsed.semantic.every(
            (e) => typeof e.$type === 'string' && !e.$type.startsWith('undefined'),
          ),
        ).toBe(true);
      }
      const combined = await parse((await toBpmnCombined(model)).xml);
      expect(combined.warnings).toEqual([]);
    });
  }

  it('XSD : le contrôle détecte un XML invalide (sensibilité)', () => {
    if (!hasXmllint) return;
    const dir = mkdtempSync(join(tmpdir(), 'bpmn-xsd-'));
    try {
      const file = join(dir, 'bad.bpmn');
      writeFileSync(
        file,
        '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="x"><bpmn:inconnu/></bpmn:definitions>',
      );
      expect(spawnSync('xmllint', ['--noout', '--schema', XSD, file]).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('@processia/bpmn : correspondance des identifiants', () => {
  /** Éléments du modèle qui doivent avoir une forme dans chaque diagramme. */
  function expected(model: BusinessModel, diagram: string): Set<string> {
    const els = Object.values(model.elements);
    const out = new Set<string>();
    const [level, anchor] = diagram.split(':') as [string, string | undefined];
    if (level === 'L0') {
      for (const e of els) {
        if (e.kind === 'activity' && e.level === 'macro') out.add(e.id);
        if (e.kind === 'process_link') out.add(e.id);
      }
      return out;
    }
    out.add(anchor as string);
    const kids = els.filter(
      (e) =>
        e.kind === 'activity' &&
        e.parentId === anchor &&
        (level === 'L1'
          ? e.level === 'process'
          : level === 'L2'
            ? e.level !== 'step'
            : e.level === 'step'),
    );
    for (const k of kids) out.add(k.id);
    if (level !== 'L1') {
      for (const e of els) {
        if (
          (e.kind === 'event' || e.kind === 'gateway' || e.kind === 'sequence_flow') &&
          e.containerId === anchor
        ) {
          out.add(e.id);
        }
      }
    }
    return out;
  }

  for (const [name, build] of models) {
    it(`${name} : chaque élément du diagramme a exactement une forme portant processia:elementId`, async () => {
      const model = build();
      for (const d of listDiagrams(model)) {
        const parsed = await parse((await toBpmn(model, d)).xml);
        const ids = [
          ...parsed.shapes.map((s) => s.elementId),
          ...parsed.edges.map((e) => e.elementId),
        ].filter((x): x is string => x !== undefined);
        // Une seule forme par élément.
        expect(new Set(ids).size, `${d} : doublon`).toBe(ids.length);
        // Tout identifiant existe dans le modèle.
        for (const id of ids) expect(model.elements[id], `${d} : ${id} inconnu`).toBeDefined();
        // Tout élément attendu est présent.
        for (const id of expected(model, d)) {
          expect(ids, `${d} : ${model.elements[id]?.label}`).toContain(id);
        }
      }
    });
  }

  it('les identifiants BPMN sont dérivés des identifiants du modèle, dans les deux sens', async () => {
    const model = buildRichModel();
    for (const d of listDiagrams(model)) {
      const parsed = await parse((await toBpmn(model, d)).xml);
      for (const s of parsed.shapes) {
        if (s.elementId === undefined) continue;
        const el: Element | undefined = model.elements[s.elementId];
        if (
          el?.kind === 'activity' &&
          s.type !== 'bpmn:Participant' &&
          s.type !== 'bpmn:SubProcess'
        ) {
          expect(s.bpmnId).toBe(`Activity_${compact(el.id)}`);
        }
        if (el?.kind === 'event') expect(s.bpmnId).toBe(`Event_${compact(el.id)}`);
        if (el?.kind === 'gateway') expect(s.bpmnId).toBe(`Gateway_${compact(el.id)}`);
        if (s.bpmnId.match(/^(Activity|Event|Gateway)_/)) {
          expect(elementIdFromBpmnId(s.bpmnId)).toBe(s.elementId);
        }
      }
      for (const e of parsed.edges) {
        if (e.elementId !== undefined && e.bpmnId.startsWith('Flow_')) {
          expect(e.bpmnId).toBe(`Flow_${compact(e.elementId)}`);
        }
      }
    }
  });

  it('les identifiants BPMN sont uniques dans le fichier combiné', async () => {
    const model = buildRichModel();
    const xml = (await toBpmnCombined(model)).xml;
    const ids = [...xml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('@processia/bpmn : contenu BPMN', () => {
  it('niveau 2 : tâches typées, agent IA, passerelles, événements de bord, bassins fermés et messages', async () => {
    const model = buildRichModel();
    const p1 = Object.values(model.elements).find(
      (e) => e.label === 'Relance des pièces manquantes',
    ) as Element;
    const { xml } = await toBpmn(model, `L2:${p1.id}`);
    expect(xml).toContain('<bpmn:collaboration');
    expect(xml).toContain('<bpmn:laneSet');
    expect(xml).toContain('<bpmn:manualTask');
    expect(xml).toContain('<bpmn:serviceTask');
    expect(xml).toContain('<bpmn:sendTask');
    expect(xml).toContain('<processia:AiAgent capability="document_classification"');
    expect(xml).toContain('<bpmn:exclusiveGateway');
    expect(xml).toContain('<bpmn:parallelGateway');
    expect(xml).toContain('<bpmn:boundaryEvent');
    expect(xml).toContain('<bpmn:timerEventDefinition');
    expect(xml).toContain('<bpmn:dataObjectReference');
    expect(xml).toContain('<bpmn:dataInputAssociation');
    expect(xml).toContain('<bpmn:dataOutputAssociation');
    expect(xml).toContain('default="Flow_');
    expect(xml).toContain('<bpmn:documentation>Règle');
    expect((xml.match(/<bpmn:messageFlow /g) ?? []).length).toBe(3);
    // Deux bassins fermés : le client et la banque (système tiers).
    expect((xml.match(/<bpmn:participant /g) ?? []).length).toBe(3);
    // Une tâche sans acteur tombe dans le couloir « Non affecté » ; les tâches utilisateur sont typées.
    const p3 = Object.values(model.elements).find((e) => e.label === 'Clôture') as Element;
    const l2p3 = (await toBpmn(model, `L2:${p3.id}`)).xml;
    expect(l2p3).toContain('<bpmn:userTask');
    expect(l2p3).toContain('name="Non affecté"');
  });

  it('niveau 1 : un couloir par acteur et une activité d’appel par processus ; niveau 0 : groupes', async () => {
    const model = buildRichModel();
    const macro = Object.values(model.elements).find(
      (e) => e.label === 'Tenue comptable',
    ) as Element;
    const l1 = (await toBpmn(model, `L1:${macro.id}`)).xml;
    expect((l1.match(/<bpmn:callActivity /g) ?? []).length).toBe(4);
    expect((l1.match(/<bpmn:lane /g) ?? []).length).toBe(4); // Comptable, Assistant, Associé, Non affecté
    const l0 = (await toBpmn(model, 'L0')).xml;
    expect((l0.match(/<bpmn:callActivity /g) ?? []).length).toBe(5);
    expect((l0.match(/<bpmn:group /g) ?? []).length).toBe(3);
    expect((l0.match(/<bpmn:sequenceFlow /g) ?? []).length).toBe(1);
    expect((l0.match(/<bpmn:textAnnotation /g) ?? []).length).toBe(2);
  });

  it('niveau 3 : sous-processus développé, règles en annotations, exception en événement de bord', async () => {
    const model = buildRichModel();
    const t2 = Object.values(model.elements).find(
      (e) => e.label === 'Envoyer la relance',
    ) as Element;
    expect(listDiagrams(model)).toContain(`L3:${t2.id}`);
    const xml = (await toBpmn(model, `L3:${t2.id}`)).xml;
    expect(xml).toContain('<bpmn:subProcess');
    expect(xml).toContain('isExpanded="true"');
    expect(xml).toContain('<bpmn:textAnnotation');
    expect(xml).toContain('<bpmn:boundaryEvent');
    expect(xml).toContain('Champs :');
  });

  it('le modèle minimal donne les 4 niveaux (L0, L1, L2 et L3)', () => {
    const ds = listDiagrams(buildMinimalModel());
    expect(ds.filter((d) => d.startsWith('L0'))).toHaveLength(1);
    expect(ds.filter((d) => d.startsWith('L1'))).toHaveLength(2);
    expect(ds.filter((d) => d.startsWith('L2'))).toHaveLength(1);
    expect(ds.filter((d) => d.startsWith('L3'))).toHaveLength(1);
  });

  it('refuse un diagramme dont l’élément support est absent', async () => {
    const model = buildRichModel();
    await expect(toBpmn(model, 'L2:01900000-ffff-7000-8000-000000000000')).rejects.toThrow();
    await expect(toBpmn(model, 'X')).rejects.toThrow();
  });
});

describe('@processia/bpmn : déterminisme et export', () => {
  for (const [name, build] of models) {
    it(`${name} : même modèle, XML identique à l'octet près`, async () => {
      const a = build();
      const b = build();
      for (const d of listDiagrams(a)) {
        expect((await toBpmn(a, d)).xml).toBe((await toBpmn(b, d)).xml);
      }
      expect((await toBpmnCombined(a)).xml).toBe((await toBpmnCombined(b)).xml);
    });
  }

  it('le ZIP contient un fichier par diagramme et le fichier combiné, et il est reproductible', async () => {
    const model = buildRichModel();
    const first = await exportBpmnZip(model);
    const second = await exportBpmnZip(buildRichModel());
    expect(Buffer.from(first.zip).equals(Buffer.from(second.zip))).toBe(true);
    const files = unzipSync(first.zip);
    const diagrams = listDiagrams(model);
    expect(Object.keys(files).sort()).toEqual(
      [...diagrams.map(diagramFileName), COMBINED_FILE_NAME].sort(),
    );
    expect(diagrams.length).toBeGreaterThanOrEqual(4);
    for (const d of diagrams) {
      const xml = strFromU8(files[diagramFileName(d)] as Uint8Array);
      expect(xml).toBe((await toBpmn(model, d)).xml);
      // Un seul diagramme par fichier.
      expect((xml.match(/<bpmndi:BPMNDiagram /g) ?? []).length).toBe(1);
    }
    const combined = strFromU8(files[COMBINED_FILE_NAME] as Uint8Array);
    expect((combined.match(/<bpmndi:BPMNDiagram /g) ?? []).length).toBe(diagrams.length);
  });
});

describe('@processia/bpmn : mise en page', () => {
  const CONTAINERS = new Set(['bpmn:Participant', 'bpmn:Lane', 'bpmn:Group', 'bpmn:SubProcess']);

  function overlaps(a: Shape, b: Shape): boolean {
    return (
      a.box.x < b.box.x + b.box.w &&
      b.box.x < a.box.x + a.box.w &&
      a.box.y < b.box.y + b.box.h &&
      b.box.y < a.box.y + a.box.h
    );
  }

  for (const [name, build] of models) {
    it(`${name} : aucune forme ne se recouvre`, async () => {
      const model = build();
      for (const d of listDiagrams(model)) {
        const parsed = await parse((await toBpmn(model, d)).xml);
        const attached = new Map<string, string>(
          parsed.semantic
            .filter((e) => e.$type === 'bpmn:BoundaryEvent')
            .map((e) => [e.id as string, (e['attachedToRef'] as ModdleElement).id as string]),
        );
        const leaves = parsed.shapes.filter((s) => !CONTAINERS.has(s.type));
        for (let i = 0; i < leaves.length; i++) {
          for (let j = i + 1; j < leaves.length; j++) {
            const a = leaves[i] as Shape;
            const b = leaves[j] as Shape;
            if (attached.get(a.bpmnId) === b.bpmnId || attached.get(b.bpmnId) === a.bpmnId)
              continue;
            expect(overlaps(a, b), `${d} : ${a.bpmnId} / ${b.bpmnId}`).toBe(false);
          }
        }
        // Les couloirs d'un bassin ne se recouvrent pas non plus, ni les bassins.
        const bands = parsed.shapes.filter((s) => s.type === 'bpmn:Lane');
        for (let i = 0; i < bands.length; i++) {
          for (let j = i + 1; j < bands.length; j++) {
            expect(overlaps(bands[i] as Shape, bands[j] as Shape), `${d} couloirs`).toBe(false);
          }
        }
        const pools = parsed.shapes.filter((s) => s.type === 'bpmn:Participant');
        for (let i = 0; i < pools.length; i++) {
          for (let j = i + 1; j < pools.length; j++) {
            expect(overlaps(pools[i] as Shape, pools[j] as Shape), `${d} bassins`).toBe(false);
          }
        }
        // Chaque forme d'un couloir est dans son couloir.
        for (const e of parsed.edges) expect(e.points).toBeGreaterThanOrEqual(2);
      }
    });
  }

  it('les formes d’un couloir sont dans les limites de ce couloir', async () => {
    const model = buildRichModel();
    const p1 = Object.values(model.elements).find(
      (e) => e.label === 'Relance des pièces manquantes',
    ) as Element;
    const { xml } = await toBpmn(model, `L2:${p1.id}`);
    const { rootElement } = await createModdle().fromXML(xml);
    const defs = rootElement as ModdleElement;
    const process = (defs['rootElements'] as ModdleElement[]).find(
      (e) => e.$type === 'bpmn:Process',
    ) as ModdleElement;
    const lanes = ((process['laneSets'] as ModdleElement[])[0] as ModdleElement)[
      'lanes'
    ] as ModdleElement[];
    const parsed = await parse(xml);
    const byId = new Map(parsed.shapes.map((s) => [s.bpmnId, s]));
    for (const lane of lanes) {
      const lb = (byId.get(lane.id as string) as Shape).box;
      for (const ref of lane['flowNodeRef'] as ModdleElement[]) {
        const s = (byId.get(ref.id as string) as Shape).box;
        const cx = s.x + s.w / 2;
        const cy = s.y + s.h / 2;
        expect(
          cx >= lb.x && cx <= lb.x + lb.w && cy >= lb.y && cy <= lb.y + lb.h,
          `${lane.id} ${ref.id}`,
        ).toBe(true);
      }
    }
  });

  it('positions mémorisées : un second rendu produit le même XML et aucune opération', async () => {
    const model = buildRichModel();
    let current = model;
    for (const d of listDiagrams(model)) {
      const r = await toBpmn(current, d);
      expect(r.layoutOps.length).toBeLessThanOrEqual(1);
      for (const op of r.layoutOps) {
        if (op.op === 'set_layout') {
          current = {
            ...current,
            layout: { ...current.layout, [d]: { ...(current.layout[d] ?? {}), ...op.positions } },
          };
        }
      }
    }
    for (const d of listDiagrams(model)) {
      const first = await toBpmn(model, d);
      const again = await toBpmn(current, d);
      expect(again.layoutOps, d).toEqual([]);
      expect(again.xml, d).toBe(first.xml);
    }
  });

  it('stabilité : ajouter une tâche puis refaire le rendu ne déplace pas plus de 10 % des formes', async () => {
    const model = buildRichModel();
    const p1 = Object.values(model.elements).find(
      (e) => e.label === 'Relance des pièces manquantes',
    ) as Element;
    const diagram = `L2:${p1.id}`;
    const first = await toBpmn(model, diagram);
    const op = first.layoutOps[0];
    if (op?.op !== 'set_layout') throw new Error('opération set_layout attendue');
    const stored: BusinessModel = { ...model, layout: { [diagram]: op.positions } };

    const added = addTaskToRichModel(stored);
    const before = await parse((await toBpmn(stored, diagram)).xml);
    const after = await parse((await toBpmn(added.model, diagram)).xml);
    const afterById = new Map(after.shapes.map((s) => [s.bpmnId, s]));
    let moved = 0;
    for (const s of before.shapes) {
      const n = afterById.get(s.bpmnId);
      if (!n || n.box.x !== s.box.x || n.box.y !== s.box.y) moved += 1;
    }
    expect(moved / before.shapes.length).toBeLessThanOrEqual(0.1);
    expect(after.shapes.length).toBe(before.shapes.length + 1);
    // La nouvelle tâche est présente, sans recouvrement.
    expect(after.shapes.some((s) => s.elementId === added.taskId)).toBe(true);
    const leaves = after.shapes.filter((s) => !CONTAINERS.has(s.type));
    const attached = new Set(
      after.semantic.filter((e) => e.$type === 'bpmn:BoundaryEvent').map((e) => e.id as string),
    );
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i] as Shape;
        const b = leaves[j] as Shape;
        if (attached.has(a.bpmnId) || attached.has(b.bpmnId)) continue;
        expect(overlaps(a, b), `${a.bpmnId} / ${b.bpmnId}`).toBe(false);
      }
    }
  });

  it('sans positions mémorisées, ajouter une tâche déplace davantage (le contrôle est sensible)', async () => {
    const model = buildRichModel();
    const p1 = Object.values(model.elements).find(
      (e) => e.label === 'Relance des pièces manquantes',
    ) as Element;
    const diagram = `L2:${p1.id}`;
    const added = addTaskToRichModel(model);
    const before = await parse((await toBpmn(model, diagram)).xml);
    const after = await parse((await toBpmn(added.model, diagram)).xml);
    const afterById = new Map(after.shapes.map((s) => [s.bpmnId, s]));
    const moved = before.shapes.filter((s) => {
      const n = afterById.get(s.bpmnId);
      return !n || n.box.x !== s.box.x || n.box.y !== s.box.y;
    }).length;
    expect(moved / before.shapes.length).toBeGreaterThan(0.1);
  });

  it('les ops set_layout s’appliquent au modèle (cause layout) sans changer son contenu', async () => {
    const model = buildCompleteModel();
    const d = listDiagrams(model).find((x) => x.startsWith('L2')) as string;
    const { layoutOps } = await toBpmn(model, d);
    const cs: ChangeSet = {
      baseVersion: model.version,
      cause: 'layout',
      summary: 'mise en page',
      ops: layoutOps,
    };
    const r = applyChangeSet(model, cs);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.model.layout[d] ?? {}).length).toBeGreaterThan(5);
      expect(r.model.elements).toEqual(model.elements);
    }
  });
});
