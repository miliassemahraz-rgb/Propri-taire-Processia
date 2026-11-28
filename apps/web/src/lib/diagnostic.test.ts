import {
  buildActivity,
  buildActor,
  buildFinding,
  buildInformationFlow,
  buildModel,
  buildStatus,
  resetTestIds,
} from '@processia/model';
import { describe, expect, it } from 'vitest';
import {
  diagnosticCounts,
  findingLocations,
  findingsOf,
  groupByFamily,
  severityKey,
} from './diagnostic';

function setup() {
  resetTestIds();
  const macro = buildActivity({ level: 'macro', label: 'Macro' });
  const process = buildActivity({ level: 'process', parentId: macro.id });
  const task = buildActivity({ level: 'task', parentId: process.id, label: 'Tâche' });
  const actor = buildActor();
  const flow = buildInformationFlow({ fromActorId: actor.id, toActorId: actor.id });
  const low = buildFinding({ family: 'waste', severity: 1, location: [task.id] });
  const high = buildFinding({
    family: 'waste',
    severity: 3,
    location: [task.id, flow.id],
    status: buildStatus({ value: 'hypothesis' }),
  });
  const org = buildFinding({
    family: 'organisation',
    type: 'task_without_owner',
    location: [task.id],
  });
  const model = buildModel([macro, process, task, actor, flow, low, high, org]);
  return { model, task, flow, low, high, org };
}

describe('diagnostic (page)', () => {
  it('trie les constats par gravité décroissante puis par code', () => {
    const { model, high, low } = setup();
    const sorted = findingsOf(model);
    expect(sorted[0]?.id).toBe(high.id);
    expect(sorted.at(-1)?.id).toBe(low.id);
    expect(findingsOf(null)).toEqual([]);
  });

  it('groupe par famille, les quatre familles toujours présentes', () => {
    const { model } = setup();
    const groups = groupByFamily(findingsOf(model));
    expect(groups.map((g) => g.family)).toEqual([
      'waste',
      'flow_and_delay',
      'organisation',
      'risk_compliance',
    ]);
    expect(groups.map((g) => g.findings.length)).toEqual([2, 0, 1, 0]);
  });

  it('compte les constats à examiner et confirmés', () => {
    const { model } = setup();
    expect(diagnosticCounts(findingsOf(model))).toEqual({ total: 3, pending: 1, confirmed: 2 });
  });

  it('traduit la gravité en clé de libellé', () => {
    expect([severityKey(1), severityKey(2), severityKey(3)]).toEqual(['low', 'medium', 'high']);
  });

  it('localise sur la cartographie : un diagramme pour une tâche, aucun pour un flux sans activité', () => {
    const { model, high, task, flow } = setup();
    const locations = findingLocations(model, 'mission-1', high);
    expect(locations.map((l) => l.id)).toEqual([task.id, flow.id]);
    expect(locations[0]?.diagram).toMatch(/^L2:/);
    expect(locations[0]?.href).toBe(
      `/missions/mission-1/cartographie?element=${encodeURIComponent(task.id)}`,
    );
    expect(locations[1]?.diagram).toBeNull();
  });
});
