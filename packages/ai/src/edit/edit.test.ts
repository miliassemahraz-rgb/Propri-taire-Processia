import {
  PILOT_DESCRIPTION,
  PILOT_EDIT_SCENARIOS,
  PILOT_FLOW_SCENARIOS,
  PILOT_RELANCE_PROCESS,
  PILOT_RELANCE_TASK,
  PILOT_SCENARIOS,
  type ScenarioRequest,
} from '@processia/test-fixtures';
import {
  applyChangeSet,
  checkCoherence,
  CURRENT_SCHEMA_VERSION,
  uuidv7,
  type Activity,
  type BusinessModel,
  type ChangeSet,
} from '@processia/model';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  matchExisting,
  mergeCandidates,
  summarizeModel,
  verifyChunkCandidates,
} from '../extraction/candidates.js';
import { buildExtractionChangeSet } from '../extraction/changeset.js';
import { FakeProvider, type FakeScenario } from '../fake-provider.js';
import { buildProcessFlowChangeSet, buildProcessFlowInput } from '../flow/plan.js';
import { extractionChunkPipeline } from '../pipelines/extraction.js';
import { modelEditPipeline, type EditPlan } from '../pipelines/model-edit.js';
import { processFlowPipeline } from '../pipelines/process-flow.js';
import { runPipeline } from '../runner.js';
import { buildEditChangeSet, buildEditInput, EditPlanError } from './plan.js';

const MISSION = '01900000-0000-7000-8000-000000000001';
const AT = '2026-11-27T10:00:00.000Z';
const USER = '01900000-0000-7000-8000-0000000000bb';
const fake = new FakeProvider({
  scenarios: {
    ...(PILOT_SCENARIOS as Record<string, (req: ScenarioRequest) => unknown>),
    ...PILOT_FLOW_SCENARIOS,
    ...PILOT_EDIT_SCENARIOS,
  } as Record<string, FakeScenario>,
});
const deps = { provider: fake };
const ctx = { clientId: 'client' };

let counter = 0;
const newId = (): string => {
  counter += 1;
  return uuidv7(1_700_000_000_000 + counter, new Uint8Array(10).fill(counter % 251));
};

const empty = (): BusinessModel => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  missionId: MISSION,
  version: 0,
  elements: {},
  rejectedHypotheses: [],
  layout: {},
});

function apply(
  model: BusinessModel,
  cs: ChangeSet,
  actor: 'ai' | 'consultant' = 'ai',
): BusinessModel {
  const res = applyChangeSet(model, cs, { newId, at: AT, actor, userId: USER });
  if (!res.ok) throw new Error(JSON.stringify(res.errors, null, 2));
  return res.model;
}

const processByLabel = (m: BusinessModel, label: string): Activity =>
  Object.values(m.elements).find(
    (e): e is Activity => e.kind === 'activity' && e.level === 'process' && e.label === label,
  ) as Activity;

/** Pilote extrait, enchaînements des processus « Contrôle des écritures » et « Relances clients ». */
async function pilotWithFlows(): Promise<BusinessModel> {
  let model = empty();
  const chunk = {
    chunkId: 'chunk-1',
    sourceId: '01900000-0000-7000-8000-0000000000aa',
    sourceRevision: 1,
    origin: 'free_text' as const,
    title: 'Source',
    text: PILOT_DESCRIPTION,
    locator: { paragraph: 1 },
  };
  const out = await runPipeline(
    extractionChunkPipeline,
    { chunk, model: summarizeModel(model) },
    ctx,
    deps,
  );
  const merged = mergeCandidates(
    verifyChunkCandidates({ chunk, candidates: out.candidates, aiCallId: 'call' }, 0),
  );
  const built = buildExtractionChangeSet({
    model,
    ...merged,
    matches: matchExisting(merged.candidates, merged.mergedInto, model),
    discrepancies: [],
    at: AT,
  });
  model = apply(model, built.changeSet as ChangeSet);
  for (const label of [
    'Contrôle des écritures',
    'Traitement des anomalies',
    PILOT_RELANCE_PROCESS,
  ]) {
    const process = processByLabel(model, label);
    const input = buildProcessFlowInput(model, process.id, 'flow');
    const output = await runPipeline(processFlowPipeline, input, ctx, deps);
    const flow = buildProcessFlowChangeSet({
      model,
      processId: process.id,
      mode: 'flow',
      output,
      aiCallId: 'call-flow',
      at: AT,
      newId,
    });
    model = apply(model, flow.changeSet as ChangeSet);
  }
  return model;
}

let pilot: BusinessModel;
beforeAll(async () => {
  pilot = await pilotWithFlows();
});

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

async function ask(
  model: BusinessModel,
  instruction: string,
  diagram: string,
  history: Turn[] = [],
): Promise<EditPlan> {
  const input = buildEditInput({ model, instruction, history, diagram });
  return runPipeline(modelEditPipeline, input, ctx, deps);
}

const l2 = (m: BusinessModel, label: string): string => `L2:${processByLabel(m, label).id}`;

function build(model: BusinessModel, plan: EditPlan, instruction = 'consigne') {
  return buildEditChangeSet({
    model,
    plan,
    instruction,
    userId: USER,
    aiCallId: 'call-edit',
    at: AT,
  });
}

function structure(model: BusinessModel) {
  return checkCoherence(model).filter((i) =>
    ['DEAD_END_BRANCH', 'UNREACHABLE_NODE', 'PROCESS_WITHOUT_START_OR_END'].includes(i.code),
  );
}

describe('model.edit : contexte réduit', () => {
  it('au niveau 2, le détail du processus visé ; aux niveaux 0 et 1, la liste compacte', () => {
    const controle = processByLabel(pilot, 'Contrôle des écritures');
    const l2Input = buildEditInput({
      model: pilot,
      instruction: 'x',
      history: [],
      diagram: `L2:${controle.id}`,
    });
    expect(l2Input.processes).toHaveLength(1);
    expect(l2Input.scope?.code).toBe(controle.code);
    expect(l2Input.scope?.nodes.some((n) => n.kind === 'event')).toBe(true);
    expect(l2Input.scope?.flows.length).toBeGreaterThan(2);
    const l0 = buildEditInput({ model: pilot, instruction: 'x', history: [] });
    expect(l0.scope).toBeUndefined();
    expect(l0.processes.length).toBe(45);
    // Le contexte réduit est nettement plus petit que le modèle entier.
    expect(JSON.stringify(l2Input).length).toBeLessThan(JSON.stringify(pilot).length / 20);
  });
});

describe('model.edit : consignes types (scénario factice)', () => {
  it('ajouter une validation par le chef de mission après la révision', async () => {
    const diagram = l2(pilot, 'Contrôle des écritures');
    const plan = await ask(
      pilot,
      'ajoute une validation par le chef de mission après la révision',
      diagram,
    );
    expect(plan.clarification).toBeUndefined();
    expect(plan.actions).toHaveLength(1);
    const { changeSet, touchedIds } = build(pilot, plan);
    expect(changeSet.cause).toBe('dialogue_edit');
    expect(touchedIds.length).toBeGreaterThan(1);
    const res = applyChangeSet(pilot, changeSet, { newId, at: AT, actor: 'consultant' });
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    const created = Object.values(res.model.elements).filter((e) => !(e.id in pilot.elements));
    const task = created.find((e): e is Activity => e.kind === 'activity') as Activity;
    expect(task.label).toBe('Validation par le chef de mission');
    expect(task.level).toBe('task');
    expect(res.model.elements[task.responsibleActorId as string]?.label).toBe('Chef de mission');
    expect(task.status.value).toBe('confirmed');
    expect(task.provenance.origin).toBe('consultant');
    expect(task.provenance.aiCallId).toBe('call-edit');
    // Deux flux créés ou recâblés, le graphe reste sain.
    expect(res.diff.modified.some((m) => m.fields.includes('toId'))).toBe(true);
    expect(structure(res.model)).toEqual([]);
    expect(res.warnings.some((w) => w.code === 'ACTIVITY_WITHOUT_OWNER')).toBe(false);
  });

  it('une tâche sans responsable donne ACTIVITY_WITHOUT_OWNER', async () => {
    const plan = await ask(
      pilot,
      'ajoute une étape « Contrôle qualité » après la réalisation',
      l2(pilot, 'Contrôle des écritures'),
    );
    const { changeSet } = build(pilot, plan);
    const res = applyChangeSet(pilot, changeSet, { newId, at: AT, actor: 'consultant' });
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.warnings.map((w) => w.code)).toContain('ACTIVITY_WITHOUT_OWNER');
  });

  it('déplacer une tâche vers un autre acteur', async () => {
    const plan = await ask(
      pilot,
      'déplace la tâche Contrôle des écritures : réalisation vers le collaborateur comptable',
      l2(pilot, 'Contrôle des écritures'),
    );
    expect(plan.actions[0]).toMatchObject({ action: 'reassign', actor: 'Collaborateur comptable' });
    const { changeSet } = build(pilot, plan);
    const next = apply(pilot, changeSet, 'consultant');
    const task = Object.values(next.elements).find(
      (e): e is Activity =>
        e.kind === 'activity' && e.label === 'Contrôle des écritures : réalisation',
    ) as Activity;
    expect(next.elements[task.responsibleActorId as string]?.label).toBe('Collaborateur comptable');
    expect(task.raci.filter((r) => r.role === 'R')).toHaveLength(1);
    expect(task.status.value).toBe('confirmed');
    expect(task.status.correction).toBeDefined();
  });

  it('ajouter une exception de relance', async () => {
    const diagram = l2(pilot, PILOT_RELANCE_PROCESS);
    const plan = await ask(
      pilot,
      `ajoute une exception de relance à la tâche ${PILOT_RELANCE_TASK}`,
      diagram,
    );
    expect(plan.actions[0]).toMatchObject({ action: 'add_exception', circuit: 'reminder' });
    const { changeSet } = build(pilot, plan);
    const next = apply(pilot, changeSet, 'consultant');
    const rule = Object.values(next.elements).find(
      (e) => e.kind === 'rule' && !(e.id in pilot.elements),
    );
    expect(rule?.kind === 'rule' && rule.type).toBe('exception');
    const task = Object.values(next.elements).find(
      (e): e is Activity => e.kind === 'activity' && e.label === PILOT_RELANCE_TASK,
    ) as Activity;
    expect(task.ruleIds).toContain(rule?.id);
  });

  it('supprimer une étape raccorde la précédente à la suivante', async () => {
    const diagram = l2(pilot, 'Contrôle des écritures');
    const plan = await ask(
      pilot,
      'supprime la tâche Contrôle des écritures : préparation',
      diagram,
    );
    expect(plan.actions[0]).toMatchObject({ action: 'remove' });
    const { changeSet } = build(pilot, plan);
    const next = apply(pilot, changeSet, 'consultant');
    expect(
      Object.values(next.elements).some((e) => e.label === 'Contrôle des écritures : préparation'),
    ).toBe(false);
    expect(structure(next)).toEqual([]);
    // Le flux de début mène maintenant à la tâche suivante.
    const process = processByLabel(next, 'Contrôle des écritures');
    const flows = Object.values(next.elements).filter(
      (e) => e.kind === 'sequence_flow' && e.containerId === process.id,
    );
    const start = Object.values(next.elements).find(
      (e) => e.kind === 'event' && e.containerId === process.id && e.position === 'start',
    );
    const out = flows.find((f) => f.kind === 'sequence_flow' && f.fromId === start?.id);
    expect(next.elements[(out?.kind === 'sequence_flow' && out.toId) as string]?.label).toBe(
      'Contrôle des écritures : réalisation',
    );
    // Hypothèse supprimée : elle est rejetée (jamais reproposée).
    expect(next.rejectedHypotheses.length).toBeGreaterThan(0);
  });

  it('renommer', async () => {
    const plan = await ask(
      pilot,
      'renomme la tâche Contrôle des écritures : réalisation en « Revue des écritures »',
      l2(pilot, 'Contrôle des écritures'),
    );
    const { changeSet } = build(pilot, plan);
    const next = apply(pilot, changeSet, 'consultant');
    expect(Object.values(next.elements).some((e) => e.label === 'Revue des écritures')).toBe(true);
  });

  it('changer un indicateur', async () => {
    // Niveau 3 de la relance : indicateurs de délai.
    const process = processByLabel(pilot, PILOT_RELANCE_PROCESS);
    const task = Object.values(pilot.elements).find(
      (e): e is Activity => e.kind === 'activity' && e.label === PILOT_RELANCE_TASK,
    ) as Activity;
    const detailIn = buildProcessFlowInput(pilot, process.id, 'detail', [task.id]);
    const detailOut = await runPipeline(processFlowPipeline, detailIn, ctx, deps);
    const model = apply(
      pilot,
      buildProcessFlowChangeSet({
        model: pilot,
        processId: process.id,
        mode: 'detail',
        detailTaskIds: [task.id],
        output: detailOut,
        aiCallId: 'c',
        at: AT,
        newId,
      }).changeSet as ChangeSet,
    );
    const plan = await ask(
      model,
      'change l’indicateur Délai de réponse attendu du client à 10 jours',
      `L2:${process.id}`,
    );
    expect(plan.actions[0]).toMatchObject({ action: 'set_indicator', exact: 10, unit: 'jours' });
    const { changeSet } = build(model, plan);
    const next = apply(model, changeSet, 'consultant');
    const indicator = Object.values(next.elements).find(
      (e) => e.kind === 'indicator' && e.label === 'Délai de réponse attendu du client',
    );
    expect(indicator?.kind === 'indicator' && indicator.value).toEqual({ exact: 10 });
    expect(indicator?.status.value).toBe('confirmed');
  });
});

describe('model.edit : clarification', () => {
  it('une consigne sans position pose une question, la réponse la complète', async () => {
    const diagram = l2(pilot, 'Contrôle des écritures');
    const first = 'ajoute une validation par le chef de mission';
    const question = await ask(pilot, first, diagram);
    expect(question.clarification).toMatch(/endroit/);
    expect(question.actions).toEqual([]);
    const answer = await ask(pilot, 'après la révision', diagram, [
      { role: 'user', content: first },
      { role: 'assistant', content: question.clarification as string },
    ]);
    expect(answer.clarification).toBeUndefined();
    expect(answer.actions[0]).toMatchObject({ action: 'insert_task', placement: 'after' });
  });

  it('une cible ambiguë (niveau 0) est précisée par une question', async () => {
    const plan = await ask(
      pilot,
      'ajoute une validation par le chef de mission après la révision',
      'L0',
    );
    expect(plan.clarification).toMatch(/plusieurs processus/);
  });

  it('une consigne incomprise explique ce que l’outil sait faire', async () => {
    const plan = await ask(pilot, 'bonjour', 'L0');
    expect(plan.clarification).toMatch(/ajouter une étape/);
  });

  it('un acteur inconnu est signalé', async () => {
    const plan = await ask(
      pilot,
      'ajoute une validation par le directeur général après la révision',
      l2(pilot, 'Contrôle des écritures'),
    );
    expect(plan.clarification).toMatch(/directeur général/);
  });
});

describe('buildEditChangeSet : refus', () => {
  const plan = (action: Record<string, unknown>): EditPlan =>
    ({ explanation: 'x', actions: [action], touched: [] }) as EditPlan;

  it('un code inconnu est refusé', () => {
    expect(() => build(pilot, plan({ action: 'remove', target: 'P99.9' }))).toThrow(EditPlanError);
  });

  it('un acteur inconnu est refusé', () => {
    const task = Object.values(pilot.elements).find(
      (e): e is Activity => e.kind === 'activity' && e.level === 'task',
    ) as Activity;
    expect(() =>
      build(pilot, plan({ action: 'reassign', target: task.code, actor: 'Personne' })),
    ).toThrow(/Acteur inconnu/);
  });

  it('deux actions qui touchent la même valeur sont refusées', () => {
    const tasks = Object.values(pilot.elements).filter(
      (e): e is Activity => e.kind === 'activity' && e.level === 'task',
    );
    const task = tasks[0] as Activity;
    expect(() =>
      build(pilot, {
        explanation: 'x',
        touched: [],
        actions: [
          { action: 'rename', target: task.code, label: 'A' },
          { action: 'rename', target: task.code, label: 'B' },
        ],
      }),
    ).toThrow(/séparément/);
  });

  it('on ne supprime pas une passerelle qui a plusieurs suites', () => {
    const gateway = Object.values(pilot.elements).find((e) => e.kind === 'gateway');
    expect(gateway).toBeDefined();
    expect(() =>
      build(pilot, plan({ action: 'remove', target: (gateway as { code: string }).code })),
    ).toThrow(/plusieurs suites/);
  });

  it('rien n’est écrit sans action', () => {
    expect(() => build(pilot, { explanation: 'x', actions: [], touched: [] })).toThrow(
      EditPlanError,
    );
  });
});
