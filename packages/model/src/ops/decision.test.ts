import { beforeEach, describe, expect, it } from 'vitest';
import type { Optimisation } from '../schema/optimisation.js';
import type { OptimisationDecision } from '../schema/validation.js';
import { buildOptimisation, resetTestIds } from '../testing/index.js';
import {
  activeDecisions,
  applyDecision,
  closureBlockers,
  type DecisionInput,
  optimisationStates,
  previewCascade,
} from './decision.js';
import {
  detectOptimisationConflicts,
  findDependencyCycle,
  topologicalOrder,
  type DependencyNode,
} from './graph.js';

const AT = '2026-04-01T10:00:00.000Z';
const input = (optimisationId: string, value: 'accepted' | 'rejected', at = AT): DecisionInput => ({
  optimisationId,
  value,
  submissionId: 'sub-1',
  by: 'validator-1',
  at,
});

/** Crée des optimisations A, B, C… ; `deps` : nom -> noms dont il dépend. */
function graphOf(deps: Record<string, string[]>) {
  const opts: Record<string, Optimisation> = {};
  for (const name of Object.keys(deps)) opts[name] = buildOptimisation({ code: `OPT-${name}` });
  for (const [name, ds] of Object.entries(deps)) {
    (opts[name] as Optimisation).dependsOn = ds.map((d) => (opts[d] as Optimisation).id);
  }
  const id = (n: string) => (opts[n] as Optimisation).id;
  const nodes: DependencyNode[] = Object.values(opts).map((o) => ({
    id: o.id,
    code: o.code,
    dependsOn: o.dependsOn,
  }));
  const names = Object.fromEntries(Object.entries(opts).map(([n, o]) => [o.id, n]));
  return { opts, nodes, id, names };
}

/** Rejoue des décisions successives et renvoie l'historique. */
function run(nodes: DependencyNode[], steps: DecisionInput[]): OptimisationDecision[] {
  let decisions: OptimisationDecision[] = [];
  for (const s of steps) {
    const r = applyDecision(nodes, decisions, s);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    decisions = r.decisions;
  }
  return decisions;
}

describe('cascade (spécification 2.7)', () => {
  beforeEach(() => resetTestIds());

  it('chaîne A←B←C : refuser A refuse B et C en cascade depuis A', () => {
    // B dépend de A, C dépend de B.
    const { nodes, id } = graphOf({ A: [], B: ['A'], C: ['B'] });
    const r = applyDecision(nodes, [], input(id('A'), 'rejected'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cascaded).toEqual([id('B'), id('C')]);
    const active = activeDecisions(r.decisions);
    expect(active.get(id('A'))).toMatchObject({ value: 'rejected', cause: 'direct' });
    for (const n of ['B', 'C']) {
      expect(active.get(id(n))).toMatchObject({
        value: 'rejected',
        cause: 'cascade',
        cascadeFrom: id('A'),
      });
    }
  });

  it('refuser le milieu B refuse C mais pas A ; refuser C ne touche à rien d’autre', () => {
    const { nodes, id } = graphOf({ A: [], B: ['A'], C: ['B'] });
    const mid = applyDecision(nodes, [], input(id('B'), 'rejected'));
    expect(mid.ok && mid.cascaded).toEqual([id('C')]);
    const leaf = applyDecision(nodes, [], input(id('C'), 'rejected'));
    expect(leaf.ok && leaf.cascaded).toEqual([]);
    expect(leaf.ok && leaf.created).toHaveLength(1);
  });

  it('diamant : D dépend de B et C, qui dépendent de A ; refuser A refuse B, C et D une fois chacun', () => {
    const { nodes, id } = graphOf({ A: [], B: ['A'], C: ['A'], D: ['B', 'C'] });
    const r = applyDecision(nodes, [], input(id('A'), 'rejected'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.cascaded].sort()).toEqual([id('B'), id('C'), id('D')].sort());
    expect(new Set(r.cascaded).size).toBe(3);
    expect(r.created).toHaveLength(4);
  });

  it('diamant : refuser B seul refuse D mais laisse C', () => {
    const { nodes, id } = graphOf({ A: [], B: ['A'], C: ['A'], D: ['B', 'C'] });
    const r = applyDecision(
      nodes,
      run(nodes, [input(id('C'), 'accepted')]),
      input(id('B'), 'rejected'),
    );
    expect(r.ok && r.cascaded).toEqual([id('D')]);
    expect(r.ok && activeDecisions(r.decisions).get(id('C'))?.value).toBe('accepted');
  });

  it('le refus en cascade écrase une acceptation antérieure et la remplace dans l’historique', () => {
    const { nodes, id } = graphOf({ A: [], B: ['A'] });
    const decisions = run(nodes, [
      input(id('B'), 'accepted', '2026-04-01T09:00:00.000Z'),
      input(id('A'), 'rejected'),
    ]);
    const forB = decisions.filter((d) => d.optimisationId === id('B'));
    expect(forB).toHaveLength(2);
    expect(forB[0]).toMatchObject({ value: 'accepted', supersededAt: AT });
    expect(forB[1]).toMatchObject({ value: 'rejected', cause: 'cascade' });
    expect(forB[1]?.supersededAt).toBeUndefined();
  });

  it('un refus direct existant n’est pas écrasé par un refus en cascade', () => {
    const { nodes, id } = graphOf({ A: [], B: ['A'] });
    const decisions = run(nodes, [input(id('B'), 'rejected')]);
    const r = applyDecision(nodes, decisions, input(id('A'), 'rejected'));
    expect(r.ok && r.cascaded).toEqual([]);
    expect(r.ok && activeDecisions(r.decisions).get(id('B'))).toMatchObject({ cause: 'direct' });
  });

  it('aucun rétablissement automatique : accepter A après coup laisse B et C refusés [PO-7]', () => {
    const { nodes, id } = graphOf({ A: [], B: ['A'], C: ['B'] });
    const decisions = run(nodes, [input(id('A'), 'rejected'), input(id('A'), 'accepted')]);
    const active = activeDecisions(decisions);
    expect(active.get(id('A'))?.value).toBe('accepted');
    expect(active.get(id('B'))).toMatchObject({ value: 'rejected', cause: 'cascade' });
    expect(active.get(id('C'))).toMatchObject({ value: 'rejected', cause: 'cascade' });
    // Le validateur peut ensuite accepter B de nouveau (A accepté), pas C tant que B est refusé.
    const b = applyDecision(nodes, decisions, input(id('B'), 'accepted'));
    expect(b.ok).toBe(true);
    const c = applyDecision(nodes, decisions, input(id('C'), 'accepted'));
    expect(c).toMatchObject({ ok: false, error: { code: 'DEPENDENCY_REJECTED' } });
  });

  it('refuser une optimisation sans dépendante ne touche à rien d’autre', () => {
    const { nodes, id } = graphOf({ A: [], B: [], C: ['A'] });
    const r = applyDecision(nodes, [], input(id('B'), 'rejected'));
    expect(r.ok && r.created.map((d) => d.optimisationId)).toEqual([id('B')]);
  });

  it('refuse une optimisation inconnue', () => {
    const { nodes } = graphOf({ A: [] });
    expect(applyDecision(nodes, [], input('inconnue', 'accepted'))).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_OPTIMISATION' },
    });
  });

  it('ne modifie pas l’historique reçu', () => {
    const { nodes, id } = graphOf({ A: [], B: ['A'] });
    const before = run(nodes, [input(id('B'), 'accepted')]);
    const copy = structuredClone(before);
    applyDecision(nodes, before, input(id('A'), 'rejected'));
    expect(before).toEqual(copy);
  });
});

describe('acceptation sous réserve et clôture', () => {
  beforeEach(() => resetTestIds());

  it('accepter Y alors que sa dépendance n’est pas décidée donne « accepté sous réserve »', () => {
    const { nodes, id } = graphOf({ X: [], Y: ['X'] });
    const decisions = run(nodes, [input(id('Y'), 'accepted')]);
    expect(optimisationStates(nodes, decisions)).toEqual({
      [id('X')]: 'undecided',
      [id('Y')]: 'accepted_with_reservation',
    });
    expect(closureBlockers(nodes, decisions)).toEqual([
      { code: 'UNDECIDED', optimisationId: id('X') },
      { code: 'DEPENDENCY_NOT_ACCEPTED', optimisationId: id('Y'), dependencyIds: [id('X')] },
    ]);
  });

  it('accepter ensuite X lève la réserve et débloque la clôture', () => {
    const { nodes, id } = graphOf({ X: [], Y: ['X'] });
    const decisions = run(nodes, [input(id('Y'), 'accepted'), input(id('X'), 'accepted')]);
    expect(optimisationStates(nodes, decisions)).toEqual({
      [id('X')]: 'accepted',
      [id('Y')]: 'accepted',
    });
    expect(closureBlockers(nodes, decisions)).toEqual([]);
  });

  it('une dépendance refusée directement interdit d’accepter la dépendante', () => {
    const { nodes, id } = graphOf({ X: [], Y: ['X'] });
    // Y est déjà refusée en cascade ; accepter Y alors que X est refusé est impossible.
    const decisions = run(nodes, [input(id('X'), 'rejected')]);
    expect(applyDecision(nodes, decisions, input(id('Y'), 'accepted'))).toMatchObject({
      ok: false,
      error: { code: 'DEPENDENCY_REJECTED', dependencyIds: [id('X')] },
    });
  });

  it('une décision est modifiable : la nouvelle remplace la précédente', () => {
    const { nodes, id } = graphOf({ X: [] });
    const decisions = run(nodes, [input(id('X'), 'accepted'), input(id('X'), 'rejected')]);
    expect(decisions).toHaveLength(2);
    expect(activeDecisions(decisions).get(id('X'))?.value).toBe('rejected');
    expect(closureBlockers(nodes, decisions)).toEqual([]);
  });

  it('l’aperçu de la cascade liste les dépendantes touchées avec leur état actuel', () => {
    const { nodes, id } = graphOf({ A: [], B: ['A'], C: ['B'] });
    const decisions = run(nodes, [input(id('C'), 'accepted')]);
    const p = previewCascade(nodes, decisions, id('A'));
    expect(p).toEqual({
      ok: true,
      preview: {
        affected: [
          { optimisationId: id('B'), current: 'undecided' },
          { optimisationId: id('C'), current: 'accepted_with_reservation' },
        ],
      },
    });
  });

  it('scénario WP-23 : le validateur accepte C puis refuse A ; B et C sont refusés depuis A', () => {
    const { nodes, id } = graphOf({ A: [], B: ['A'], C: ['B'] });
    const decisions = run(nodes, [input(id('C'), 'accepted'), input(id('A'), 'rejected')]);
    const active = activeDecisions(decisions);
    expect(active.get(id('B'))).toMatchObject({
      value: 'rejected',
      cause: 'cascade',
      cascadeFrom: id('A'),
    });
    expect(active.get(id('C'))).toMatchObject({
      value: 'rejected',
      cause: 'cascade',
      cascadeFrom: id('A'),
    });
  });
});

describe('cycles et ordre topologique', () => {
  beforeEach(() => resetTestIds());

  it.each([
    ['auto-dépendance', { A: ['A'] }],
    ['cycle de deux', { A: ['B'], B: ['A'] }],
    ['cycle de trois derrière une queue', { X: ['A'], A: ['B'], B: ['C'], C: ['A'] }],
  ])('détecte un cycle : %s', (_n, deps) => {
    const { nodes, id, names } = graphOf(deps as Record<string, string[]>);
    const cycle = findDependencyCycle(nodes);
    expect(cycle).not.toBeNull();
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
    expect(topologicalOrder(nodes).ok).toBe(false);
    const first = Object.keys(deps)[0] as string;
    expect(applyDecision(nodes, [], input(id(first), 'rejected'))).toMatchObject({
      ok: false,
      error: { code: 'DEPENDENCY_CYCLE' },
    });
    expect(cycle?.every((c) => names[c] !== undefined)).toBe(true);
  });

  it('un graphe acyclique n’a pas de cycle', () => {
    const { nodes } = graphOf({ A: [], B: ['A'], C: ['A', 'B'] });
    expect(findDependencyCycle(nodes)).toBeNull();
  });

  it('une dépendance inconnue est refusée', () => {
    const { nodes, id } = graphOf({ A: [] });
    const broken = [{ ...(nodes[0] as DependencyNode), dependsOn: ['fantôme'] }];
    expect(applyDecision(broken, [], input(id('A'), 'accepted'))).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_DEPENDENCY' },
    });
  });

  it('l’ordre topologique place les dépendances d’abord, puis trie par code', () => {
    const { nodes, id } = graphOf({ D: ['B'], C: [], B: ['A'], A: [] });
    const r = topologicalOrder(nodes);
    expect(r).toEqual({ ok: true, order: [id('A'), id('B'), id('C'), id('D')] });
  });
});

describe('conflits entre optimisations (règle 7)', () => {
  beforeEach(() => resetTestIds());

  it.each([
    ['mêmes éléments touchés, sans dépendance : conflit', ['E1'], ['E1'], [], [], 1],
    ['éléments disjoints : pas de conflit', ['E1'], ['E2'], [], [], 0],
    ['dépendance déclarée : pas de conflit', ['E1'], ['E1'], ['A'], [], 0],
    ['dépendance indirecte : pas de conflit', ['E1'], ['E1'], ['M'], [], 0],
    ['alternative l’une de l’autre : pas de conflit', ['E1'], ['E1'], [], ['A'], 0],
  ])('%s', (_n, touchedA, touchedB, depsB, altB, expected) => {
    const A = buildOptimisation({ code: 'OPT-A', touchedElementIds: touchedA });
    const M = buildOptimisation({ code: 'OPT-M', touchedElementIds: ['Z'], dependsOn: [A.id] });
    const resolve = (n: string) => (n === 'A' ? A.id : n === 'M' ? M.id : n);
    const B = buildOptimisation({
      code: 'OPT-B',
      touchedElementIds: touchedB,
      dependsOn: depsB.map(resolve),
      ...(altB.length > 0 ? { alternativeOf: A.id } : {}),
    });
    const conflicts = detectOptimisationConflicts([A, M, B]);
    expect(conflicts).toHaveLength(expected);
    if (expected > 0) {
      expect(conflicts[0]).toEqual({ a: A.id, b: B.id, elementIds: ['E1'] });
    }
  });

  it('déduit aussi les éléments touchés des opérations du ChangeSet', () => {
    const A = buildOptimisation({
      code: 'OPT-A',
      changeSet: {
        baseVersion: 1,
        cause: 'optimisation',
        summary: 's',
        ops: [{ op: 'update', id: 'E9', set: {} }],
      },
    });
    const B = buildOptimisation({
      code: 'OPT-B',
      changeSet: {
        baseVersion: 1,
        cause: 'optimisation',
        summary: 's',
        ops: [{ op: 'remove', id: 'E0', cascade: ['E9'] }],
      },
    });
    expect(detectOptimisationConflicts([A, B])).toEqual([{ a: A.id, b: B.id, elementIds: ['E9'] }]);
  });
});
