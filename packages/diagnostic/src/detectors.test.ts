import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildActivity,
  buildActor,
  buildDataObject,
  buildEvent,
  buildGateway,
  buildInformationFlow,
  buildModel,
  buildSequenceFlow,
  buildTool,
  resetTestIds,
  type Activity,
  type Element,
} from '@processia/model';
import {
  DETECTORS,
  detectMissingTraceability,
  detectPaperOrEmailTransfer,
  detectRekeying,
  detectSinglePersonDependency,
  detectTaskWithoutOwner,
  detectUselessValidationLoop,
  runDetectors,
} from './detectors.js';
import { DETECTOR_IDS } from './types.js';

beforeEach(() => resetTestIds());

function process() {
  const macro = buildActivity({ level: 'macro', label: 'Macro' });
  const proc = buildActivity({ level: 'process', parentId: macro.id, label: 'Processus' });
  return { macro, proc };
}

const task = (parent: Activity, extra: Partial<Activity> = {}): Activity =>
  buildActivity({ level: 'task', parentId: parent.id, ...extra });

describe('task_without_owner', () => {
  it('signale une tâche sans responsable ni R', () => {
    const { macro, proc } = process();
    const orphan = task(proc, { label: 'Orpheline' });
    const found = detectTaskWithoutOwner(buildModel([macro, proc, orphan]));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      type: 'task_without_owner',
      family: 'organisation',
      location: [orphan.id],
      detection: { by: 'rule', detectorId: 'task_without_owner' },
    });
  });

  it('ne signale pas une tâche dont le responsable ou le R est connu', () => {
    const { macro, proc } = process();
    const actor = buildActor();
    const owned = task(proc, { responsibleActorId: actor.id });
    const raci = task(proc, { raci: [{ actorId: actor.id, role: 'R' }] });
    const onlyInformed = task(proc, { raci: [{ actorId: actor.id, role: 'I' }] });
    const found = detectTaskWithoutOwner(
      buildModel([macro, proc, actor, owned, raci, onlyInformed]),
    );
    expect(found.map((f) => f.location[0])).toEqual([onlyInformed.id]);
  });
});

describe('paper_or_email_transfer', () => {
  it('signale un flux par courriel ou papier, localisé sur son activité', () => {
    const { macro, proc } = process();
    const [from, to] = [buildActor(), buildActor()];
    const step = task(proc, { responsibleActorId: from.id });
    const mail = buildInformationFlow({
      fromActorId: from.id,
      toActorId: to.id,
      channel: 'email',
      activityId: step.id,
    });
    const paper = buildInformationFlow({
      fromActorId: from.id,
      toActorId: to.id,
      channel: 'paper',
    });
    const found = detectPaperOrEmailTransfer(
      buildModel([macro, proc, from, to, step, mail, paper]),
    );
    expect(found).toHaveLength(2);
    expect(found.find((f) => f.location.includes(mail.id))?.location).toEqual([step.id, mail.id]);
    expect(found.find((f) => f.location.includes(paper.id))?.severity).toBe(3);
  });

  it('ne signale pas un flux par logiciel, portail ou téléphone', () => {
    const [from, to] = [buildActor(), buildActor()];
    const flows = (['software', 'portal', 'phone', 'oral', 'unknown'] as const).map((channel) =>
      buildInformationFlow({ fromActorId: from.id, toActorId: to.id, channel }),
    );
    expect(detectPaperOrEmailTransfer(buildModel([from, to, ...flows]))).toEqual([]);
  });
});

describe('rekeying', () => {
  function setup(opts: { sameActor?: boolean; sharedTool?: boolean; automatic?: boolean }) {
    const { macro, proc } = process();
    const [a1, a2] = [buildActor({ label: 'Saisie A' }), buildActor({ label: 'Saisie B' })];
    const data = buildDataObject({ label: 'Facture' });
    const tool = buildTool();
    const t1 = task(proc, {
      responsibleActorId: a1.id,
      inputs: [data.id],
      toolIds: opts.sharedTool ? [tool.id] : [],
    });
    const t2 = task(proc, {
      responsibleActorId: opts.sameActor ? a1.id : a2.id,
      inputs: [data.id],
      toolIds: opts.sharedTool ? [tool.id] : [],
      execution: opts.automatic ? 'automatic' : 'manual',
    });
    return { model: buildModel([macro, proc, a1, a2, data, tool, t1, t2]), t1, t2, data };
  }

  it('signale un objet saisi par deux acteurs différents sans outil commun', () => {
    const { model, t1, t2, data } = setup({});
    const found = detectRekeying(model);
    expect(found).toHaveLength(1);
    expect(found[0]?.location).toEqual([t1.id, t2.id, data.id]);
    expect(found[0]?.family).toBe('waste');
  });

  it.each([
    ['le même acteur', { sameActor: true }],
    ['un outil commun', { sharedTool: true }],
    ['une activité automatique', { automatic: true }],
  ])('ne signale pas avec %s', (_name, opts) => {
    expect(detectRekeying(setup(opts).model)).toEqual([]);
  });
});

describe('single_person_dependency', () => {
  function chain(taskCount: number, mutate?: (tasks: Activity[], other: Element) => void) {
    const { macro, proc } = process();
    const owner = buildActor({ label: 'Seul', category: 'internal' });
    const other = buildActor({ label: 'Autre' });
    const tasks = Array.from({ length: taskCount }, () =>
      task(proc, { responsibleActorId: owner.id }),
    );
    mutate?.(tasks, other);
    return { model: buildModel([macro, proc, owner, other, ...tasks]), proc, tasks };
  }

  it('signale un acteur seul sur au moins trois tâches sans suppléant', () => {
    const { model, proc, tasks } = chain(3);
    const found = detectSinglePersonDependency(model);
    expect(found).toHaveLength(1);
    expect(found[0]?.location).toEqual([proc.id, ...tasks.map((t) => t.id)]);
  });

  it('ne signale pas une chaîne courte', () => {
    expect(detectSinglePersonDependency(chain(2).model)).toEqual([]);
  });

  it('ne signale pas quand un suppléant est consulté ou qu’un autre acteur est responsable', () => {
    const withDeputy = chain(3, (tasks, other) => {
      (tasks[0] as Activity).raci = [{ actorId: other.id, role: 'C' }];
    });
    expect(detectSinglePersonDependency(withDeputy.model)).toEqual([]);
    const withOtherOwner = chain(3, (tasks, other) => {
      (tasks[2] as Activity).responsibleActorId = other.id;
    });
    expect(detectSinglePersonDependency(withOtherOwner.model)).toEqual([]);
  });

  it('ne signale pas un acteur externe', () => {
    const { macro, proc } = process();
    const client = buildActor({ category: 'external' });
    const tasks = [1, 2, 3].map(() => task(proc, { responsibleActorId: client.id }));
    expect(detectSinglePersonDependency(buildModel([macro, proc, client, ...tasks]))).toEqual([]);
  });
});

describe('useless_validation_loop', () => {
  /** start → t1 → t2 → t3 → gw → (retour à t1 | end) */
  function loop(taskCount: number) {
    const { macro, proc } = process();
    const tasks = Array.from({ length: taskCount }, () => task(proc));
    const gw = buildGateway({ containerId: proc.id });
    const start = buildEvent({ containerId: proc.id, position: 'start' });
    const end = buildEvent({ containerId: proc.id, position: 'end' });
    const chainIds = [start.id, ...tasks.map((t) => t.id), gw.id];
    const flows = chainIds
      .slice(0, -1)
      .map((from, i) =>
        buildSequenceFlow({ containerId: proc.id, fromId: from, toId: chainIds[i + 1] as string }),
      );
    flows.push(
      buildSequenceFlow({ containerId: proc.id, fromId: gw.id, toId: end.id }),
      buildSequenceFlow({ containerId: proc.id, fromId: gw.id, toId: (tasks[0] as Activity).id }),
    );
    return { model: buildModel([macro, proc, ...tasks, gw, start, end, ...flows]), tasks, gw };
  }

  it('signale une boucle qui traverse plus de deux activités et une passerelle', () => {
    const { model, tasks, gw } = loop(3);
    const found = detectUselessValidationLoop(model);
    expect(found).toHaveLength(1);
    expect(new Set(found[0]?.location)).toEqual(new Set([...tasks.map((t) => t.id), gw.id]));
    expect(found[0]?.type).toBe('useless_validation_loop');
  });

  it('ne signale pas une boucle courte (deux activités ou moins)', () => {
    expect(detectUselessValidationLoop(loop(2).model)).toEqual([]);
    expect(detectUselessValidationLoop(loop(1).model)).toEqual([]);
  });

  it('ne signale pas un enchaînement sans boucle', () => {
    const { macro, proc } = process();
    const tasks = [task(proc), task(proc), task(proc)];
    const flows = [
      buildSequenceFlow({
        containerId: proc.id,
        fromId: (tasks[0] as Activity).id,
        toId: (tasks[1] as Activity).id,
      }),
      buildSequenceFlow({
        containerId: proc.id,
        fromId: (tasks[1] as Activity).id,
        toId: (tasks[2] as Activity).id,
      }),
    ];
    expect(detectUselessValidationLoop(buildModel([macro, proc, ...tasks, ...flows]))).toEqual([]);
  });
});

describe('missing_traceability', () => {
  /** start → t1 → gw → (end | t1) ; `outputs` : sortie documentée de t1. */
  function decision(documented: boolean, type: 'exclusive' | 'parallel' = 'exclusive') {
    const { macro, proc } = process();
    const data = buildDataObject();
    const t1 = task(proc, { outputs: documented ? [data.id] : [] });
    const gw = buildGateway({ containerId: proc.id, type });
    const end = buildEvent({ containerId: proc.id, position: 'end' });
    const flows = [
      buildSequenceFlow({ containerId: proc.id, fromId: t1.id, toId: gw.id }),
      buildSequenceFlow({ containerId: proc.id, fromId: gw.id, toId: end.id }),
      buildSequenceFlow({ containerId: proc.id, fromId: gw.id, toId: t1.id }),
    ];
    return { model: buildModel([macro, proc, data, t1, gw, end, ...flows]), t1, gw };
  }

  it('signale une décision qu’aucune sortie ne documente', () => {
    const { model, t1, gw } = decision(false);
    const found = detectMissingTraceability(model);
    expect(found).toHaveLength(1);
    expect(found[0]?.location).toEqual([gw.id, t1.id]);
    expect(found[0]?.family).toBe('risk_compliance');
  });

  it('ne signale pas une décision documentée, ni une passerelle parallèle', () => {
    expect(detectMissingTraceability(decision(true).model)).toEqual([]);
    expect(detectMissingTraceability(decision(false, 'parallel').model)).toEqual([]);
  });
});

describe('runDetectors', () => {
  it('chaque détecteur déclaré existe, et deux exécutions donnent le même résultat', () => {
    expect(Object.keys(DETECTORS)).toEqual([...DETECTOR_IDS]);
    const { macro, proc } = process();
    const model = buildModel([macro, proc, task(proc), task(proc)]);
    expect(runDetectors(model)).toEqual(runDetectors(model));
    expect(runDetectors(model).every((f) => f.location.length >= 1)).toBe(true);
  });
});
