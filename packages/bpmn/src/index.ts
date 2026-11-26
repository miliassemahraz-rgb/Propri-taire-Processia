/**
 * @processia/bpmn : projection déterministe du modèle métier en BPMN 2.0 sur 4 niveaux (WP-18).
 * Paquet pur : pas d'entrée/sortie, pas d'horloge ; même modèle, même XML.
 */
import { zipSync, strToU8 } from 'fflate';
import type { ModdleElement } from 'bpmn-moddle';
import type { BusinessModel, DiagramId, LayoutBox, ModelOp } from '@processia/model';
import { renderDiagram, type RenderedDiagram } from './build.js';
import { diagramKey } from './ids.js';
import { listDiagrams } from './diagrams.js';
import { DEFAULT_LABELS, type BpmnLabels } from './labels.js';
import { createModdle } from './moddle.js';

export const PACKAGE_NAME = '@processia/bpmn' as const;

export { listDiagrams, parseDiagramId, type DiagramKind } from './diagrams.js';
export { bpmnId, compact, diagramKey, elementIdFromBpmnId, PROCESSIA_NS } from './ids.js';
export { DEFAULT_LABELS, type BpmnLabels } from './labels.js';
export { PROCESSIA_DESCRIPTOR, createModdle } from './moddle.js';

export interface BpmnOptions {
  labels?: Partial<BpmnLabels>;
}

export interface BpmnResult {
  xml: string;
  /** Opérations `set_layout` à appliquer (cause `layout`) : seulement les positions nouvelles ou changées. */
  layoutOps: ModelOp[];
}

function resolveLabels(options: BpmnOptions | undefined): BpmnLabels {
  return {
    ...DEFAULT_LABELS,
    ...options?.labels,
    categories: { ...DEFAULT_LABELS.categories, ...options?.labels?.categories },
    linkNature: { ...DEFAULT_LABELS.linkNature, ...options?.labels?.linkNature },
  };
}

function changedPositions(
  model: BusinessModel,
  diagram: DiagramId,
  positions: Record<string, LayoutBox>,
): Record<string, LayoutBox> {
  const stored = model.layout[diagram] ?? {};
  const out: Record<string, LayoutBox> = {};
  for (const id of Object.keys(positions).sort()) {
    const p = positions[id] as LayoutBox;
    const s = stored[id];
    if (!s || s.x !== p.x || s.y !== p.y || s.w !== p.w || s.h !== p.h) out[id] = p;
  }
  return out;
}

async function serialize(
  rendered: RenderedDiagram[],
  id: string,
  moddle = createModdle(),
): Promise<string> {
  const definitions: ModdleElement = moddle.create('bpmn:Definitions', {
    id,
    targetNamespace: 'urn:processia:mission',
    exporter: 'Processia',
    exporterVersion: '1',
    rootElements: rendered.flatMap((r) => r.roots),
    diagrams: rendered.map((r) => r.diagram),
  });
  return (await moddle.toXML(definitions, { format: true })).xml;
}

/**
 * BPMN 2.0 d'un diagramme (`L0`, `L1:<macro>`, `L2:<processus>`, `L3:<tâche>`), avec sa mise en page.
 * Asynchrone (elkjs) ; la sortie ne dépend que du modèle (positions mémorisées comprises).
 */
export async function toBpmn(
  model: BusinessModel,
  diagram: DiagramId,
  options?: BpmnOptions,
): Promise<BpmnResult> {
  const moddle = createModdle();
  const r = await renderDiagram(moddle, model, diagram, resolveLabels(options));
  const xml = await serialize([r], `Definitions_${diagramKey(diagram)}`, moddle);
  const positions = changedPositions(model, diagram, r.positions);
  const layoutOps: ModelOp[] =
    Object.keys(positions).length > 0 ? [{ op: 'set_layout', diagram, positions }] : [];
  return { xml, layoutOps };
}

/** Fichier combiné : tous les diagrammes dans un seul `definitions`. */
export async function toBpmnCombined(
  model: BusinessModel,
  options?: BpmnOptions,
): Promise<BpmnResult> {
  const moddle = createModdle();
  const labels = resolveLabels(options);
  const diagrams = listDiagrams(model);
  const rendered: RenderedDiagram[] = [];
  const layoutOps: ModelOp[] = [];
  for (const d of diagrams) {
    const r = await renderDiagram(moddle, model, d, labels);
    rendered.push(r);
    const positions = changedPositions(model, d, r.positions);
    if (Object.keys(positions).length > 0)
      layoutOps.push({ op: 'set_layout', diagram: d, positions });
  }
  return { xml: await serialize(rendered, 'Definitions_all', moddle), layoutOps };
}

export const COMBINED_FILE_NAME = 'cartographie-complete.bpmn';

/** Nom de fichier d'un diagramme dans le ZIP (`L0.bpmn`, `L1-<uuid>.bpmn`…). */
export function diagramFileName(diagram: DiagramId): string {
  return `${diagram.replace(':', '-')}.bpmn`;
}

/**
 * ZIP d'export : un fichier `.bpmn` par diagramme (chacun avec ses `definitions` et son DI) plus
 * `cartographie-complete.bpmn`. Dates fixes : même modèle, mêmes octets.
 */
export async function exportBpmnZip(
  model: BusinessModel,
  options?: BpmnOptions,
): Promise<{ zip: Uint8Array; files: string[]; layoutOps: ModelOp[] }> {
  const files: Record<string, Uint8Array> = {};
  const layoutOps: ModelOp[] = [];
  for (const d of listDiagrams(model)) {
    const r = await toBpmn(model, d, options);
    files[diagramFileName(d)] = strToU8(r.xml);
    layoutOps.push(...r.layoutOps);
  }
  const combined = await toBpmnCombined(model, options);
  files[COMBINED_FILE_NAME] = strToU8(combined.xml);
  const names = Object.keys(files).sort();
  const sorted: Record<string, Uint8Array> = {};
  for (const n of names) sorted[n] = files[n] as Uint8Array;
  const zip = zipSync(sorted, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) });
  return { zip, files: names, layoutOps };
}
