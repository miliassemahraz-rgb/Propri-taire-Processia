import {
  PILOT_DESCRIPTION,
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
  type Element,
} from '@processia/model';
import { describe, expect, it } from 'vitest';
import {
  matchExisting,
  mergeCandidates,
  summarizeModel,
  verifyChunkCandidates,
} from '../extraction/candidates.js';
import { buildExtractionChangeSet } from '../extraction/changeset.js';
import { FakeProvider, type FakeScenario } from '../fake-provider.js';
import { extractionChunkPipeline } from '../pipelines/extraction.js';
import {
  checkProcessFlow,
  processFlowPipeline,
  type ProcessFlowOutput,
} from '../pipelines/process-flow.js';
import { runPipeline } from '../runner.js';
import {
  buildProcessFlowChangeSet,
  buildProcessFlowInput,
  hasProcessFlow,
  listFlowProcesses,
  ProcessFlowError,
} from './plan.js';

const MISSION = '01900000-0000-7000-8000-000000000001';
const AT = '2026-11-27T10:00:00.000Z';
const fake = new FakeProvider({
  scenarios: {
    ...(PILOT_SCENARIOS as Record<string, (req: ScenarioRequest) => unknown>),
    ...PILOT_FLOW_SCENARIOS,
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

function apply(model: BusinessModel, cs: ChangeSet): BusinessModel {
  const res = applyChangeSet(model, cs, { newId, at: AT, actor: 'ai' });
  if (!res.ok) throw new Error(JSON.stringify(res.errors, null, 2));
  return res.model;
}

/** Modèle du pilote : l'extraction de la description, comme le fait « Analyser ». */
async function pilotModel(): Promise<BusinessModel> {
  const model = empty();
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
  return apply(model, built.changeSet as ChangeSet);
}

const processByLabel = (m: BusinessModel, label: string): Activity =>
  Object.values(m.elements).find(
    (e): e is Activity => e.kind === 'activity' && e.level === 'process' && e.label === label,
  ) as Activity;

async function buildFlow(
  model: BusinessModel,
  processId: string,
  mode: 'flow' | 'detail' = 'flow',
  detailTaskIds: string[] = [],
) {
  const input = buildProcessFlowInput(model, processId, mode, detailTaskIds);
  const output = await runPipeline(processFlowPipeline, input, ctx, deps);
  return {
    output,
    build: buildProcessFlowChangeSet({
      model,
      processId,
      mode,
      detailTaskIds,
      output,
      aiCallId: 'call-flow',
      at: AT,
      newId,
    }),
  };
}

const STRUCTURE = ['DEAD_END_BRANCH', 'UNREACHABLE_NODE', 'PROCESS_WITHOUT_START_OR_END'];

describe('process.flow : enchaînements du pilote', () => {
  it('chaque processus a un début, une fin et aucune impasse (DEAD_END_BRANCH)', async () => {
    let model = await pilotModel();
    const processes = listFlowProcesses(model);
    expect(processes).toHaveLength(45);
    expect(processes.every((p) => !p.flowBuilt)).toBe(true);
    for (const p of processes) {
      const { build } = await buildFlow(model, p.id);
      expect(build.changeSet, p.code).not.toBeNull();
      model = apply(model, build.changeSet as ChangeSet);
    }
    const events = Object.values(model.elements).filter((e) => e.kind === 'event');
    for (const p of listFlowProcesses(model)) {
      expect(p.flowBuilt, p.code).toBe(true);
      const own = events.filter((e) => e.kind === 'event' && e.containerId === p.id);
      expect(
        own.some((e) => e.kind === 'event' && e.position === 'start'),
        p.code,
      ).toBe(true);
      expect(
        own.some((e) => e.kind === 'event' && e.position === 'end'),
        p.code,
      ).toBe(true);
    }
    const issues = checkCoherence(model).filter((i) => STRUCTURE.includes(i.code));
    expect(issues).toEqual([]);
  });

  it('les nouveaux éléments sont des hypothèses justifiées ; aucun élément existant ne change', async () => {
    const model = await pilotModel();
    const p = processByLabel(model, 'Saisie');
    const { build } = await buildFlow(model, p.id);
    const cs = build.changeSet as ChangeSet;
    expect(cs.cause).toBe('process_flow');
    expect(cs.ops.every((op) => op.op === 'add')).toBe(true);
    const next = apply(model, cs);
    const created = Object.values(next.elements).filter((e) => !(e.id in model.elements));
    expect(created.length).toBe(build.stats.created);
    for (const e of created) {
      expect(e.status.value, e.label).toBe('hypothesis');
      expect(e.provenance.rationale, e.label).toBeTruthy();
      expect(e.provenance.origin).toBe('ai_knowledge');
      expect(e.provenance.aiCallId).toBe('call-flow');
      expect(e.provenance.author.type).toBe('ai');
    }
    for (const [id, before] of Object.entries(model.elements)) {
      expect(next.elements[id], before.label).toEqual({
        ...before,
        meta: { ...before.meta },
      });
    }
  });

  it('un processus sans tâche reçoit des tâches proposées, avec un responsable', async () => {
    const model = await pilotModel();
    const p = processByLabel(model, 'Création des dossiers');
    const { build } = await buildFlow(model, p.id);
    const next = apply(model, build.changeSet as ChangeSet);
    const tasks = Object.values(next.elements).filter(
      (e): e is Activity => e.kind === 'activity' && e.level === 'task' && e.parentId === p.id,
    );
    expect(tasks.map((t) => t.code)).toEqual([`${p.code}.1`, `${p.code}.2`]);
    expect(tasks.every((t) => t.responsibleActorId !== undefined)).toBe(true);
    expect(tasks.every((t) => t.status.value === 'hypothesis')).toBe(true);
  });

  it('un processus dont le flux existe est ignoré (aucun doublon)', async () => {
    const model = await pilotModel();
    const p = processByLabel(model, 'Saisie');
    const first = await buildFlow(model, p.id);
    const next = apply(model, first.build.changeSet as ChangeSet);
    expect(hasProcessFlow(next, p.id)).toBe(true);
    const again = buildProcessFlowChangeSet({
      model: next,
      processId: p.id,
      mode: 'flow',
      output: first.output,
      aiCallId: null,
      at: AT,
      newId,
    });
    expect(again.changeSet).toBeNull();
  });

  it('P04 « Relance des pièces manquantes » : niveau 3 avec champs, délais et destinataires', async () => {
    let model = await pilotModel();
    const p = processByLabel(model, PILOT_RELANCE_PROCESS);
    model = apply(model, (await buildFlow(model, p.id)).build.changeSet as ChangeSet);
    const task = Object.values(model.elements).find(
      (e): e is Activity => e.kind === 'activity' && e.label === PILOT_RELANCE_TASK,
    ) as Activity;
    expect(task.parentId).toBe(p.id);
    const { build } = await buildFlow(model, p.id, 'detail', [task.id]);
    const next = apply(model, build.changeSet as ChangeSet);
    const created = (e: Element): boolean => !(e.id in model.elements);
    const all = Object.values(next.elements).filter(created);
    const steps = all.filter((e): e is Activity => e.kind === 'activity' && e.level === 'step');
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(steps.every((s) => s.parentId === task.id && s.code.startsWith(`${task.code}.`))).toBe(
      true,
    );
    const form = all.find((e) => e.kind === 'data_object');
    expect(form?.kind === 'data_object' && form.fields.map((f) => f.name)).toContain(
      'Date limite de réponse',
    );
    expect(
      all.some((e) => e.kind === 'indicator' && e.measure === 'lead_time' && e.value.exact === 7),
    ).toBe(true);
    expect(all.some((e) => e.kind === 'rule' && e.type === 'exception')).toBe(true);
    const flows = all.filter((e) => e.kind === 'information_flow');
    expect(flows.length).toBe(2);
    const client = Object.values(model.elements).find((e) => e.label === 'Client du cabinet');
    expect(flows.some((f) => f.kind === 'information_flow' && f.toActorId === client?.id)).toBe(
      true,
    );
    expect(all.every((e) => e.status.value === 'hypothesis')).toBe(true);
    expect(checkCoherence(next).filter((i) => STRUCTURE.includes(i.code))).toEqual([]);
    // Le niveau 3 n'est pas reconstruit une seconde fois.
    const again = buildProcessFlowChangeSet({
      model: next,
      processId: p.id,
      mode: 'detail',
      detailTaskIds: [task.id],
      output: (await buildFlow(model, p.id, 'detail', [task.id])).output,
      aiCallId: null,
      at: AT,
      newId,
    });
    expect(again.changeSet).toBeNull();
  });
});

describe('process.flow : contrôles', () => {
  const baseInput = async () => {
    const model = await pilotModel();
    const p = processByLabel(model, 'Saisie');
    return { model, p, input: buildProcessFlowInput(model, p.id, 'flow') };
  };
  const node = (ref: string, kind: string, extra: Record<string, unknown> = {}) => ({
    ref,
    container: 'process',
    kind,
    label: ref,
    rationale: 'r',
    ...extra,
  });
  const out = (
    nodes: Record<string, unknown>[],
    edges: { from: string; to: string }[],
  ): ProcessFlowOutput =>
    ({
      nodes,
      edges: edges.map((e) => ({ container: 'process', ...e })),
      rules: [],
      dataObjects: [],
      indicators: [],
      informationFlows: [],
      rationale: 'global',
    }) as unknown as ProcessFlowOutput;

  it('refuse une impasse, une fin absente et un acteur inconnu', async () => {
    const { input } = await baseInput();
    const noEnd = out([node('s', 'event', { position: 'start' })], []);
    expect(
      checkProcessFlow(noEnd, input)
        .map((i) => i.message)
        .join(' '),
    ).toContain('pas de fin');
    const dead = out(
      [
        node('s', 'event', { position: 'start' }),
        node('e', 'event', { position: 'end' }),
        node('x', 'event', { position: 'intermediate', actor: 'Personne' }),
      ],
      [
        { from: 's', to: 'e' },
        { from: 's', to: 'x' },
      ],
    );
    const messages = checkProcessFlow(dead, input).map((i) => i.message);
    expect(messages.some((m) => m.includes('aucun chemin vers une fin'))).toBe(true);
    expect(messages.some((m) => m.includes('Acteur inconnu'))).toBe(true);
  });

  it('refuse une passerelle de décision sans règle ni conditions, et un mode detail hors périmètre', async () => {
    const { input } = await baseInput();
    const bad = out(
      [
        node('s', 'event', { position: 'start' }),
        node('g', 'gateway', { gatewayType: 'exclusive' }),
        node('e', 'event', { position: 'end' }),
      ],
      [
        { from: 's', to: 'g' },
        { from: 'g', to: 'e' },
        { from: 'g', to: 'e' },
      ],
    );
    const messages = checkProcessFlow(bad, input)
      .map((i) => i.message)
      .join(' ');
    expect(messages).toContain("besoin d'une règle de décision");
    expect(messages).toContain('porte une condition');
    const detail = { ...input, mode: 'detail' as const };
    expect(
      checkProcessFlow(bad, detail)
        .map((i) => i.message)
        .join(' '),
    ).toContain('conteneur');
  });

  it('le ChangeSet n’est jamais construit pour un graphe invalide (modèle inchangé)', async () => {
    const { model, p } = await baseInput();
    const output = out([node('s', 'event', { position: 'start' })], []);
    expect(() =>
      buildProcessFlowChangeSet({
        model,
        processId: p.id,
        mode: 'flow',
        output,
        aiCallId: null,
        at: AT,
        newId,
      }),
    ).toThrowError(ProcessFlowError);
  });

  it('le prompt de process.flow se charge et la requête désigne le processus', async () => {
    const { input } = await baseInput();
    const request = processFlowPipeline.buildRequest(input, ctx);
    expect(request.system).toContain('UN processus');
    expect(request.messages[0]?.content).toContain('<donnees>');
    expect(request.context).toContain('Saisie');
  });
});
