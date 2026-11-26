/**
 * Mise en page d'un diagramme (spécification 6.2, ADR 0009).
 *
 * elkjs (algorithme en couches) donne les colonnes et l'ordre vertical des noeuds. Il ne connaît pas
 * les couloirs : le placement par couloir (bandes horizontales), l'empilement dans une colonne,
 * les événements de bord et le tracé orthogonal des liens sont faits ici, de façon déterministe.
 * Un rendu réutilise les positions mémorisées (`pinned`) et ne place que les nouveaux éléments.
 */
import ElkModule from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { LayoutBox } from '@processia/model';

type ElkConstructor = new () => { layout(graph: ElkNode): Promise<ElkNode> };
// Module CommonJS : le constructeur est l'export lui-même, et aussi sa propriété `default`.
const ELK = ((ElkModule as unknown as { default?: ElkConstructor }).default ??
  ElkModule) as unknown as ElkConstructor;

export interface Point {
  x: number;
  y: number;
}
export type Box = LayoutBox;

export type NodeRole = 'flow' | 'satellite' | 'boundary';

export interface LayoutNode {
  /** Identifiant BPMN du noeud (unique dans le diagramme). */
  id: string;
  /** Identifiant d'élément du modèle, clé de mémorisation de la position. */
  key?: string;
  w: number;
  h: number;
  band: string;
  role: NodeRole;
  /** `satellite` : noeud auquel il est rattaché (objet de donnée, annotation). `boundary` : tâche hôte. */
  anchor?: string;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  /** `seq` pèse sur le découpage en colonnes ; les autres liens sont seulement tracés. */
  kind: 'seq' | 'assoc';
}

export interface LayoutBand {
  id: string;
  key?: string;
}

export interface LayoutInput {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  bands: LayoutBand[];
  /** Largeur réservée à gauche du contenu (titres de couloir et de bassin). */
  headerWidth: number;
  /** Positions mémorisées, par identifiant d'élément du modèle. */
  pinned: Record<string, Box>;
}

export interface LayoutResult {
  nodes: Record<string, Box>;
  bands: Record<string, Box>;
  edges: Record<string, Point[]>;
  /** Boîte englobant toutes les bandes. */
  bounds: Box;
}

export const ORIGIN_X = 160;
export const ORIGIN_Y = 80;
const PAD_X = 40;
const PAD_Y = 30;
const COL_GAP = 70;
const ROW_GAP = 50;
const MIN_BAND_H = 140;
const WRAP = 5;
const BOUNDARY = 36;
const BOUNDARY_EXTRA = 24;
const COLLISION_MARGIN = 12;

const round = (n: number): number => Math.round(n);
const right = (b: Box): number => b.x + b.w;
const bottom = (b: Box): number => b.y + b.h;
const cx = (b: Box): number => b.x + b.w / 2;
const cy = (b: Box): number => b.y + b.h / 2;

function intersects(a: Box, b: Box, margin = 0): boolean {
  return (
    a.x < right(b) + margin &&
    b.x < right(a) + margin &&
    a.y < bottom(b) + margin &&
    b.y < bottom(a) + margin
  );
}

interface Placement {
  col: number;
  sort: [number, number, number];
}

async function computeColumns(
  input: LayoutInput,
  flowNodes: LayoutNode[],
  boundaryHost: Map<string, string>,
): Promise<Map<string, Placement>> {
  const result = new Map<string, Placement>();
  const ids = new Set(flowNodes.map((n) => n.id));
  const resolve = (id: string): string => boundaryHost.get(id) ?? id;
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const e of input.edges) {
    if (e.kind !== 'seq') continue;
    const a = resolve(e.from);
    const b = resolve(e.to);
    if (a === b || !ids.has(a) || !ids.has(b)) continue;
    const k = `${a}\u0000${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pairs.push([a, b]);
  }
  const connected = new Set<string>();
  for (const [a, b] of pairs) {
    connected.add(a);
    connected.add(b);
  }
  const linked = flowNodes.filter((n) => connected.has(n.id));
  if (linked.length > 0) {
    const elk = new ELK();
    const graph = await elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.spacing.nodeNode': '30',
        'elk.layered.spacing.nodeNodeBetweenLayers': '60',
        'elk.edgeRouting': 'ORTHOGONAL',
      },
      // Tailles uniformes : toutes les formes d'une couche partagent la même abscisse.
      children: linked.map((n) => ({ id: n.id, width: 100, height: 80 })),
      edges: pairs.map(([a, b], i) => ({ id: `e${i}`, sources: [a], targets: [b] })),
    });
    const children = graph.children ?? [];
    const xs = [...new Set(children.map((c) => c.x ?? 0))].sort((p, q) => p - q);
    for (const c of children) {
      result.set(c.id, { col: xs.indexOf(c.x ?? 0), sort: [0, c.y ?? 0, 0] });
    }
  }
  // Les noeuds sans lien sont répartis en lignes de `WRAP` colonnes, par bande.
  for (const band of input.bands) {
    let i = 0;
    for (const n of flowNodes) {
      if (n.band !== band.id || connected.has(n.id)) continue;
      result.set(n.id, { col: i % WRAP, sort: [0, Math.floor(i / WRAP), i] });
      i += 1;
    }
  }
  return result;
}

interface Stack {
  items: LayoutNode[];
  height: number;
}

function effectiveHeight(n: LayoutNode, withBoundary: Set<string>): number {
  return n.h + (withBoundary.has(n.id) ? BOUNDARY_EXTRA : 0);
}

export async function layoutDiagram(input: LayoutInput): Promise<LayoutResult> {
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  const flowNodes = input.nodes.filter((n) => n.role === 'flow');
  const boundaryHost = new Map<string, string>();
  const boundariesOf = new Map<string, LayoutNode[]>();
  for (const n of input.nodes) {
    if (n.role !== 'boundary' || n.anchor === undefined) continue;
    boundaryHost.set(n.id, n.anchor);
    const list = boundariesOf.get(n.anchor) ?? [];
    list.push(n);
    boundariesOf.set(n.anchor, list);
  }
  const withBoundary = new Set(boundariesOf.keys());
  const placements = await computeColumns(input, flowNodes, boundaryHost);
  const placeable = input.nodes.filter((n) => n.role !== 'boundary');
  const colOf = (n: LayoutNode): number => {
    if (n.role === 'flow') return placements.get(n.id)?.col ?? 0;
    const anchor = n.anchor === undefined ? undefined : nodeById.get(n.anchor);
    return anchor ? colOf(anchor) : 0;
  };
  const rankOf = (n: LayoutNode, index: number): [number, number, number] => {
    if (n.role === 'flow') {
      const p = placements.get(n.id);
      return [0, p?.sort[1] ?? 0, p?.sort[2] ?? index];
    }
    return [1, index, 0];
  };

  // Empilement par bande et colonne.
  const order = new Map(placeable.map((n, i) => [n.id, i]));
  const stacks = new Map<string, Stack>();
  const stackKey = (band: string, col: number): string => `${band}\u0000${col}`;
  for (const n of placeable) {
    const k = stackKey(n.band, colOf(n));
    const s = stacks.get(k) ?? { items: [], height: 0 };
    s.items.push(n);
    stacks.set(k, s);
  }
  for (const s of stacks.values()) {
    s.items.sort((a, b) => {
      const ra = rankOf(a, order.get(a.id) ?? 0);
      const rb = rankOf(b, order.get(b.id) ?? 0);
      return (
        ra[0] - rb[0] ||
        ra[1] - rb[1] ||
        ra[2] - rb[2] ||
        (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
      );
    });
    s.height =
      s.items.reduce((sum, n) => sum + effectiveHeight(n, withBoundary), 0) +
      ROW_GAP * (s.items.length - 1);
  }
  const colCount = placeable.reduce((m, n) => Math.max(m, colOf(n) + 1), 1);
  const colWidth: number[] = Array.from({ length: colCount }, () => 0);
  for (const n of placeable) colWidth[colOf(n)] = Math.max(colWidth[colOf(n)] ?? 0, n.w);
  const colX: number[] = [];
  let x = ORIGIN_X + input.headerWidth + PAD_X;
  for (let c = 0; c < colCount; c++) {
    colX.push(x);
    x += (colWidth[c] ?? 0) + COL_GAP;
  }
  const contentRight = x - COL_GAP + PAD_X;

  const boxes: Record<string, Box> = {};
  const bandBoxes: Record<string, Box> = {};
  let y = ORIGIN_Y;
  for (const band of input.bands) {
    let contentH = 0;
    for (let c = 0; c < colCount; c++) {
      contentH = Math.max(contentH, stacks.get(stackKey(band.id, c))?.height ?? 0);
    }
    const h = Math.max(MIN_BAND_H, contentH + 2 * PAD_Y);
    bandBoxes[band.id] = {
      x: ORIGIN_X,
      y,
      w: contentRight - ORIGIN_X,
      h,
    };
    for (let c = 0; c < colCount; c++) {
      const s = stacks.get(stackKey(band.id, c));
      if (!s) continue;
      let yy = y + (h - s.height) / 2;
      for (const n of s.items) {
        boxes[n.id] = {
          x: round(colX[c]! + ((colWidth[c] ?? 0) - n.w) / 2),
          y: round(yy),
          w: n.w,
          h: n.h,
        };
        yy += effectiveHeight(n, withBoundary) + ROW_GAP;
      }
    }
    y += h;
  }

  applyPinned(input, placeable, boxes, bandBoxes, boundariesOf, withBoundary);
  placeBoundaries(boundariesOf, boxes);

  // Bandes : même étendue horizontale.
  let left = Infinity;
  let rightMost = -Infinity;
  for (const n of input.nodes) {
    const b = boxes[n.id];
    if (!b) continue;
    left = Math.min(left, b.x - PAD_X - input.headerWidth);
    rightMost = Math.max(rightMost, right(b) + PAD_X);
  }
  for (const b of Object.values(bandBoxes)) left = Math.min(left, b.x);
  if (!Number.isFinite(left)) left = ORIGIN_X;
  if (!Number.isFinite(rightMost)) rightMost = ORIGIN_X + 200;
  for (const b of Object.values(bandBoxes)) {
    rightMost = Math.max(rightMost, right(b));
  }
  for (const id of Object.keys(bandBoxes)) {
    const b = bandBoxes[id]!;
    bandBoxes[id] = { x: round(left), y: round(b.y), w: round(rightMost - left), h: round(b.h) };
  }

  const edges: Record<string, Point[]> = {};
  for (const e of input.edges) {
    const a = boxes[e.from];
    const b = boxes[e.to];
    if (!a || !b) continue;
    const fromBoundary = nodeById.get(e.from)?.role === 'boundary';
    edges[e.id] = fromBoundary ? routeFromBoundary(a, b) : route(a, b);
  }

  const all = Object.values(bandBoxes);
  const minX = Math.min(...all.map((b) => b.x), ORIGIN_X);
  const minY = Math.min(...all.map((b) => b.y), ORIGIN_Y);
  const maxX = Math.max(...all.map(right), ORIGIN_X + 1);
  const maxY = Math.max(...all.map(bottom), ORIGIN_Y + 1);
  return {
    nodes: boxes,
    bands: bandBoxes,
    edges,
    bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  };
}

function placeBoundaries(
  boundariesOf: Map<string, LayoutNode[]>,
  boxes: Record<string, Box>,
): void {
  for (const [hostId, list] of boundariesOf) {
    const host = boxes[hostId];
    if (!host) continue;
    list.forEach((n, i) => {
      boxes[n.id] = {
        x: round(host.x + 8 + i * (BOUNDARY + 8)),
        y: round(host.y + host.h - BOUNDARY / 2),
        w: BOUNDARY,
        h: BOUNDARY,
      };
    });
  }
}

/** Réutilise les positions mémorisées ; ne place que les noeuds sans position. */
function applyPinned(
  input: LayoutInput,
  placeable: LayoutNode[],
  boxes: Record<string, Box>,
  bandBoxes: Record<string, Box>,
  boundariesOf: Map<string, LayoutNode[]>,
  withBoundary: Set<string>,
): void {
  const pinnedOf = (n: LayoutNode): Box | undefined =>
    n.key === undefined ? undefined : input.pinned[n.key];
  if (!placeable.some((n) => pinnedOf(n) !== undefined)) return;

  const fresh = { ...boxes };
  const freshBands = { ...bandBoxes };
  const finalBoxes: Record<string, Box> = {};
  for (const n of placeable) {
    const p = pinnedOf(n);
    if (p) finalBoxes[n.id] = { x: p.x, y: p.y, w: n.w, h: n.h };
  }
  // Zone de chaque bande : couloir mémorisé, sinon boîte englobante de ses noeuds mémorisés.
  const area = new Map<string, Box>();
  for (const band of input.bands) {
    const stored = band.key === undefined ? undefined : input.pinned[band.key];
    if (stored) {
      area.set(band.id, stored);
      continue;
    }
    const members = placeable.filter((n) => n.band === band.id && finalBoxes[n.id]);
    if (members.length === 0) continue;
    const bs = members.map((n) => finalBoxes[n.id]!);
    const top = Math.min(...bs.map((b) => b.y)) - PAD_Y;
    const bot = Math.max(...bs.map(bottom)) + PAD_Y;
    area.set(band.id, { x: ORIGIN_X, y: top, w: 0, h: bot - top });
  }
  const occupied = (): Box[] =>
    placeable.flatMap((n) => {
      const b = finalBoxes[n.id];
      if (!b) return [];
      return [withBoundary.has(n.id) ? { ...b, h: b.h + BOUNDARY_EXTRA } : b];
    });
  const edgeNeighbours = (id: string, dir: 'in' | 'out'): string[] =>
    input.edges
      .filter((e) => e.kind === 'seq' && (dir === 'in' ? e.to === id : e.from === id))
      .map((e) => (dir === 'in' ? e.from : e.to))
      .map((nid) => boundariesHost(nid, boundariesOf) ?? nid);
  let maxBottom = Math.max(
    ...[...area.values()].map(bottom),
    ...Object.values(finalBoxes).map(bottom),
    ORIGIN_Y,
  );
  const sorted = [...placeable]
    .filter((n) => !finalBoxes[n.id])
    .sort((a, b) => (a.role === b.role ? 0 : a.role === 'flow' ? -1 : 1));
  const newBandShift = new Map<string, number>();
  for (const n of sorted) {
    const a = area.get(n.band);
    if (!a) {
      // Bande nouvelle : on garde la disposition neuve, décalée sous le contenu existant.
      const band = freshBands[n.band];
      if (!band) continue;
      let shift = newBandShift.get(n.band);
      if (shift === undefined) {
        shift = maxBottom + 20 - band.y;
        newBandShift.set(n.band, shift);
        maxBottom = maxBottom + 20 + band.h;
      }
      const f = fresh[n.id];
      if (f) finalBoxes[n.id] = { ...f, y: f.y + shift };
      continue;
    }
    const preferred = preferredPosition(n, a, finalBoxes, edgeNeighbours);
    finalBoxes[n.id] = findFreeSpot(n, a, preferred, occupied());
  }
  // Bandes : zone mémorisée, ou boîte englobante ; nouvelles bandes sous le reste.
  for (const band of input.bands) {
    const a = area.get(band.id);
    const f = freshBands[band.id];
    if (a) bandBoxes[band.id] = { x: a.x, y: a.y, w: a.w, h: a.h };
    else if (f) {
      const shift = newBandShift.get(band.id);
      bandBoxes[band.id] = shift === undefined ? f : { ...f, y: f.y + shift };
    }
  }
  for (const id of Object.keys(boxes)) delete boxes[id];
  for (const [id, b] of Object.entries(finalBoxes)) boxes[id] = b;
}

function boundariesHost(id: string, boundariesOf: Map<string, LayoutNode[]>): string | undefined {
  for (const [host, list] of boundariesOf) if (list.some((n) => n.id === id)) return host;
  return undefined;
}

function preferredPosition(
  n: LayoutNode,
  a: Box,
  placed: Record<string, Box>,
  neighbours: (id: string, dir: 'in' | 'out') => string[],
): Point {
  const midY = a.y + (a.h - n.h) / 2;
  if (n.role === 'satellite' && n.anchor !== undefined) {
    const host = placed[n.anchor];
    if (host) return { x: host.x + (host.w - n.w) / 2, y: bottom(host) + BOUNDARY_EXTRA + 30 };
  }
  for (const id of neighbours(n.id, 'in')) {
    const p = placed[id];
    if (p) return { x: right(p) + COL_GAP, y: midY };
  }
  for (const id of neighbours(n.id, 'out')) {
    const p = placed[id];
    if (p) return { x: p.x - n.w - COL_GAP, y: midY };
  }
  return { x: a.x + PAD_X + 60, y: midY };
}

function findFreeSpot(n: LayoutNode, a: Box, start: Point, occupied: Box[]): Box {
  const minY = a.y + PAD_Y;
  const maxY = Math.max(minY, a.y + a.h - PAD_Y - n.h - (n.role === 'flow' ? 0 : 0));
  const clampY = (v: number): number => Math.min(maxY, Math.max(minY, v));
  const step = n.h + COLLISION_MARGIN + 10;
  for (let dx = 0; dx < 400; dx++) {
    const px = round(start.x + dx * 30);
    const ys = [clampY(start.y)];
    for (let k = 1; k <= 6; k++) {
      ys.push(clampY(start.y + k * step), clampY(start.y - k * step));
    }
    for (const py of ys) {
      const candidate: Box = { x: px, y: round(py), w: n.w, h: n.h };
      if (!occupied.some((o) => intersects(candidate, o, COLLISION_MARGIN))) return candidate;
    }
  }
  return { x: round(start.x), y: round(start.y), w: n.w, h: n.h };
}

/** Tracé orthogonal entre deux formes. */
export function route(a: Box, b: Box): Point[] {
  if (b.x >= right(a) + 1) {
    const s = { x: right(a), y: round(cy(a)) };
    const e = { x: b.x, y: round(cy(b)) };
    if (s.y === e.y) return [s, e];
    const mx = round(Math.max(s.x + 10, b.x - 20));
    return [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e];
  }
  if (right(b) <= a.x - 1) {
    const yb = round(Math.max(bottom(a), bottom(b)) + 30);
    return [
      { x: round(cx(a)), y: bottom(a) },
      { x: round(cx(a)), y: yb },
      { x: round(cx(b)), y: yb },
      { x: round(cx(b)), y: bottom(b) },
    ];
  }
  if (b.y >= bottom(a)) {
    const s = { x: round(cx(a)), y: bottom(a) };
    const e = { x: round(cx(b)), y: b.y };
    if (s.x === e.x) return [s, e];
    const m = round((s.y + e.y) / 2);
    return [s, { x: s.x, y: m }, { x: e.x, y: m }, e];
  }
  if (bottom(b) <= a.y) {
    const s = { x: round(cx(a)), y: a.y };
    const e = { x: round(cx(b)), y: bottom(b) };
    if (s.x === e.x) return [s, e];
    const m = round((s.y + e.y) / 2);
    return [s, { x: s.x, y: m }, { x: e.x, y: m }, e];
  }
  return [
    { x: round(cx(a)), y: round(cy(a)) },
    { x: round(cx(b)), y: round(cy(b)) },
  ];
}

function routeFromBoundary(a: Box, b: Box): Point[] {
  const s = { x: round(cx(a)), y: bottom(a) };
  if (b.x > s.x + 20) {
    const e = { x: b.x, y: round(cy(b)) };
    if (e.y > s.y + 10) return [s, { x: s.x, y: e.y }, e];
    const dy = s.y + 25;
    const mx = round(b.x - 20);
    return [s, { x: s.x, y: dy }, { x: mx, y: dy }, { x: mx, y: e.y }, e];
  }
  if (b.y >= s.y + 10) {
    const e = { x: round(cx(b)), y: b.y };
    if (e.x === s.x) return [s, e];
    const m = round((s.y + e.y) / 2);
    return [s, { x: s.x, y: m }, { x: e.x, y: m }, e];
  }
  const yb = round(Math.max(s.y, bottom(b)) + 30);
  return [s, { x: s.x, y: yb }, { x: round(cx(b)), y: yb }, { x: round(cx(b)), y: bottom(b) }];
}

/** Lien vertical entre une forme et un bassin (message), coudé si le bassin n'est pas à l'aplomb. */
export function routeVertical(a: Box, pool: Box, poolBelow: boolean): Point[] {
  const sx = round(cx(a));
  const sy = poolBelow ? bottom(a) : a.y;
  const ey = poolBelow ? pool.y : bottom(pool);
  const px = Math.min(right(pool) - 10, Math.max(pool.x + 10, sx));
  if (px === sx)
    return [
      { x: sx, y: sy },
      { x: sx, y: ey },
    ];
  const m = round((sy + ey) / 2);
  return [
    { x: sx, y: sy },
    { x: sx, y: m },
    { x: px, y: m },
    { x: px, y: ey },
  ];
}

export { bottom, cx, cy, right, intersects };
