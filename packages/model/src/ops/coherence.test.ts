import { beforeEach, describe, expect, it } from 'vitest';
import type { BusinessModel } from '../schema/business-model.js';
import {
  buildActivity,
  buildActor,
  buildCompleteModel,
  buildDataObject,
  buildEvent,
  buildGateway,
  buildInformationFlow,
  buildMinimalModel,
  buildModel,
  buildRule,
  buildSequenceFlow,
  resetTestIds,
} from '../testing/index.js';
import { parseModel } from '../parse.js';
import { checkCoherence } from './coherence.js';
import type { CoherenceCode } from './types.js';

const codes = (m: BusinessModel): CoherenceCode[] =>
  checkCoherence(m)
    .map((i) => i.code)
    .sort();

/** Cas minimaux : chacun doit déclencher exactement le code attendu (et lui seul). */
const CASES: [CoherenceCode, () => BusinessModel][] = [
  [
    'ACTIVITY_WITHOUT_OWNER',
    () => {
      const macro = buildActivity({ level: 'macro' });
      return buildModel([macro, buildActivity({ level: 'process', parentId: macro.id })]);
    },
  ],
  [
    'DATA_NEVER_PRODUCED',
    () => {
      const d = buildDataObject();
      const a = buildActor();
      const macro = buildActivity({ level: 'macro', inputs: [d.id] });
      return buildModel([d, a, macro]);
    },
  ],
  ['ORPHAN_DATA_OBJECT', () => buildModel([buildDataObject()])],
  [
    'FLOW_UNKNOWN_CHANNEL',
    () => {
      const a = buildActor();
      const b = buildActor();
      const d = buildDataObject();
      return buildModel([
        a,
        b,
        d,
        buildInformationFlow({
          fromActorId: a.id,
          toActorId: b.id,
          dataObjectIds: [d.id],
          channel: 'unknown',
        }),
      ]);
    },
  ],
  ['RULE_WITHOUT_SCOPE', () => buildModel([buildRule({ appliesTo: [] })])],
  [
    'DECISION_WITHOUT_RULE',
    () => {
      const p = buildActivity({ level: 'macro' });
      const start = buildEvent({ containerId: p.id, position: 'start' });
      const end = buildEvent({ containerId: p.id, position: 'end' });
      const g = buildGateway({ containerId: p.id, type: 'exclusive' });
      const f = (from: string, to: string) =>
        buildSequenceFlow({ containerId: p.id, fromId: from, toId: to });
      return buildModel([
        p,
        start,
        end,
        g,
        f(start.id, g.id),
        f(g.id, end.id),
        // deux sorties pour ne pas déclencher GATEWAY_SINGLE_OUTGOING
        buildSequenceFlow({ containerId: p.id, fromId: g.id, toId: end.id }),
      ]);
    },
  ],
  [
    'GATEWAY_SINGLE_OUTGOING',
    () => {
      const p = buildActivity({ level: 'macro' });
      const rule = buildRule({ appliesTo: [p.id] });
      const start = buildEvent({ containerId: p.id, position: 'start' });
      const end = buildEvent({ containerId: p.id, position: 'end' });
      const g = buildGateway({ containerId: p.id, type: 'parallel', ruleId: rule.id });
      const f = (from: string, to: string) =>
        buildSequenceFlow({ containerId: p.id, fromId: from, toId: to });
      return buildModel([p, rule, start, end, g, f(start.id, g.id), f(g.id, end.id)]);
    },
  ],
  [
    'PROCESS_WITHOUT_START_OR_END',
    () => {
      const p = buildActivity({ level: 'macro' });
      return buildModel([p, buildEvent({ containerId: p.id, position: 'start' })]);
    },
  ],
  [
    'UNREACHABLE_NODE',
    () => {
      const p = buildActivity({ level: 'macro' });
      const start = buildEvent({ containerId: p.id, position: 'start' });
      const end = buildEvent({ containerId: p.id, position: 'end' });
      const stray = buildEvent({ containerId: p.id, position: 'end' });
      return buildModel([
        p,
        start,
        end,
        stray,
        buildSequenceFlow({ containerId: p.id, fromId: start.id, toId: end.id }),
      ]);
    },
  ],
  [
    'DEAD_END_BRANCH',
    () => {
      const p = buildActivity({ level: 'macro' });
      const start = buildEvent({ containerId: p.id, position: 'start' });
      const end = buildEvent({ containerId: p.id, position: 'end' });
      const dead = buildEvent({ containerId: p.id, position: 'intermediate' });
      const f = (from: string, to: string) =>
        buildSequenceFlow({ containerId: p.id, fromId: from, toId: to });
      return buildModel([p, start, end, dead, f(start.id, end.id), f(start.id, dead.id)]);
    },
  ],
];

describe('checkCoherence : un code par règle', () => {
  beforeEach(() => resetTestIds());

  it.each(CASES)('%s', (code, make) => {
    expect(codes(make())).toEqual([code]);
  });

  it('couvre les 10 codes de la spécification', () => {
    expect(new Set(CASES.map(([c]) => c)).size).toBe(10);
  });

  it('le modèle complet de test n’a aucun avertissement et est valide', () => {
    const m = buildCompleteModel();
    expect(checkCoherence(m)).toEqual([]);
    expect(parseModel(JSON.parse(JSON.stringify(m))).ok).toBe(true);
  });

  it('un événement de bordure atteint depuis sa tâche n’est pas inatteignable', () => {
    expect(codes(buildCompleteModel())).toEqual([]);
  });

  it('les avertissements portent l’élément concerné et sont des warnings', () => {
    const [issue] = checkCoherence(buildModel([buildRule({ appliesTo: [] })]));
    expect(issue).toMatchObject({ code: 'RULE_WITHOUT_SCOPE', severity: 'warning' });
    expect(issue?.elementId).toBeTruthy();
  });

  it('le modèle minimal est analysable sans exception', () => {
    expect(Array.isArray(checkCoherence(buildMinimalModel()))).toBe(true);
  });
});
