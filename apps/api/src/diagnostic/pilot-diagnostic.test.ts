import {
  buildDiagnosticInput,
  buildProcessFlowChangeSet,
  buildProcessFlowInput,
  diagnosticPipeline,
  extractionChunkPipeline,
  FakeProvider,
  listDiagnosticMacros,
  listFlowProcesses,
  matchExisting,
  mergeCandidates,
  processFlowPipeline,
  resolveDiagnosticOutput,
  runPipeline,
  summarizeModel,
  verifyChunkCandidates,
  buildExtractionChangeSet,
  type FakeScenario,
} from '@processia/ai';
import { buildFindingsChangeSet, runDetectors, type FindingCandidate } from '@processia/diagnostic';
import {
  applyChangeSet,
  buildOutline,
  CURRENT_SCHEMA_VERSION,
  deliverableView,
  diagramOfElement,
  FINDING_FAMILIES,
  uuidv7,
  type Activity,
  type BusinessModel,
  type ChangeSet,
  type Finding,
  type ModelOp,
} from '@processia/model';
import {
  PILOT_DESCRIPTION,
  PILOT_DIAGNOSTIC_SCENARIOS,
  PILOT_FLOW_SCENARIOS,
  PILOT_RELANCE_TASK,
  PILOT_SCENARIOS,
  type ScenarioRequest,
} from '@processia/test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Critères 3 et 4 de WP-21, sans base de données : sur le pilote (extraction, enchaînements des 45
 * processus et niveau 3 de la relance, le tout confirmé), le diagnostic donne au moins un constat par
 * famille, chacun localisé sur un élément visible sur la carte ; les constats de l'IA sont des
 * hypothèses et ceux des détecteurs ont l'origine `deterministic_rule`.
 */

const MISSION = '01900000-0000-7000-8000-000000000001';
const AT = '2026-11-28T10:00:00.000Z';

const fake = new FakeProvider({
  scenarios: {
    ...(PILOT_SCENARIOS as Record<string, (req: ScenarioRequest) => unknown>),
    ...PILOT_FLOW_SCENARIOS,
    ...PILOT_DIAGNOSTIC_SCENARIOS,
  } as Record<string, FakeScenario>,
});
const deps = { provider: fake };
const ctx = { clientId: 'client' };

let counter = 0;
const newId = (): string => {
  counter += 1;
  return uuidv7(1_700_000_000_000 + counter, new Uint8Array(10).fill(counter % 251));
};

function apply(model: BusinessModel, cs: ChangeSet, actor: 'ai' | 'consultant' | 'system' = 'ai') {
  const res = applyChangeSet(model, cs, { newId, at: AT, actor, userId: 'user-1' });
  if (!res.ok) throw new Error(JSON.stringify(res.errors, null, 2));
  return res.model;
}

async function extractPilot(): Promise<BusinessModel> {
  const model: BusinessModel = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    missionId: MISSION,
    version: 0,
    elements: {},
    rejectedHypotheses: [],
    layout: {},
  };
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

async function flow(
  model: BusinessModel,
  processId: string,
  mode: 'flow' | 'detail',
  detailTaskIds: string[] = [],
): Promise<BusinessModel> {
  const input = buildProcessFlowInput(model, processId, mode, detailTaskIds);
  const output = await runPipeline(processFlowPipeline, input, ctx, deps);
  const built = buildProcessFlowChangeSet({
    model,
    processId,
    mode,
    detailTaskIds,
    output,
    aiCallId: 'call-flow',
    at: AT,
    newId,
  });
  return built.changeSet === null ? model : apply(model, built.changeSet);
}

/** Le consultant confirme toutes les hypothèses (champs de données compris). */
function confirmAll(model: BusinessModel): BusinessModel {
  const ops: ModelOp[] = [];
  for (const el of Object.values(model.elements)) {
    if (el.status.value !== 'hypothesis') continue;
    if (el.kind === 'data_object') {
      ops.push({
        op: 'update',
        id: el.id,
        set: {
          fields: el.fields.map((f) => ({
            ...f,
            status: { value: 'confirmed', decidedBy: 'user-1' },
          })),
        },
      });
    }
    ops.push({ op: 'set_status', id: el.id, status: 'confirmed' });
  }
  return apply(
    model,
    { baseVersion: model.version, ops, cause: 'hypothesis_decision', summary: 'Tout confirmer' },
    'consultant',
  );
}

let asIs: BusinessModel;
let diagnosed: BusinessModel;
let rules: FindingCandidate[];

beforeAll(async () => {
  let model = await extractPilot();
  for (const process of listFlowProcesses(model)) {
    model = await flow(model, process.id, 'flow');
  }
  const relance = Object.values(model.elements).find(
    (e): e is Activity =>
      e.kind === 'activity' && e.level === 'task' && e.label === PILOT_RELANCE_TASK,
  ) as Activity;
  model = await flow(model, relance.parentId as string, 'detail', [relance.id]);
  asIs = confirmAll(model);

  // Le diagnostic : détecteurs, puis un appel par macroprocessus.
  let head = asIs;
  const base = deliverableView(head);
  rules = runDetectors(base);
  const write = (candidates: readonly FindingCandidate[], aiCallId: string | null) => {
    const built = buildFindingsChangeSet({
      model: head,
      candidates,
      at: AT,
      aiCallId,
      summary: 'Diagnostic',
    });
    if (built.changeSet !== null)
      head = apply(head, built.changeSet, aiCallId === null ? 'system' : 'ai');
  };
  write(rules, null);
  for (const macro of listDiagnosticMacros(base)) {
    const present = Object.values(head.elements).flatMap((e) => (e.kind === 'finding' ? [e] : []));
    const input = buildDiagnosticInput(base, macro.id, [...rules, ...present]);
    const output = await runPipeline(diagnosticPipeline, input, ctx, deps);
    write(resolveDiagnosticOutput(base, macro.id, output), 'call-diag');
  }
  diagnosed = head;
}, 120_000);

const findings = (): Finding[] =>
  Object.values(diagnosed.elements).filter((e): e is Finding => e.kind === 'finding');

describe('diagnostic du pilote', () => {
  it('critère 3 : au moins un constat par famille', () => {
    const families = new Set(findings().map((f) => f.family));
    for (const family of FINDING_FAMILIES) expect(families, family).toContain(family);
  });

  it('critère 3 : chaque constat est localisé sur un élément visible sur la carte', () => {
    expect(findings().length).toBeGreaterThan(0);
    for (const finding of findings()) {
      const visible = finding.location.filter((id) => {
        const diagram = diagramOfElement(diagnosed, id);
        return (
          diagram !== undefined &&
          buildOutline(diagnosed, diagram)?.nodes.some((node) => node.id === id) === true
        );
      });
      expect(visible.length, `${finding.code} ${finding.label}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('critère 4 : les constats de l’IA sont des hypothèses, ceux des règles ont l’origine deterministic_rule', () => {
    const byAi = findings().filter((f) => f.detection.by === 'ai');
    const byRule = findings().filter((f) => f.detection.by === 'rule');
    expect(byAi.length).toBeGreaterThan(0);
    expect(byRule.length).toBeGreaterThan(0);
    for (const f of byAi) {
      expect(f.status.value).toBe('hypothesis');
      expect(f.provenance.origin).toBe('ai_knowledge');
      expect(f.provenance.rationale).toBeTruthy();
    }
    for (const f of byRule) {
      expect(f.provenance.origin).toBe('deterministic_rule');
      expect(f.detection.detectorId).toBeTruthy();
      expect(f.status.value).toBe('hypothesis');
    }
  });

  it('les détecteurs trouvent les relances par courriel et les décisions sans trace du pilote', () => {
    const types = new Set(rules.map((r) => r.type));
    expect(types).toContain('paper_or_email_transfer');
    expect(types).toContain('missing_traceability');
  });

  it('le diagnostic ne porte que sur l’AS-IS confirmé : relancé, il ne reproduit rien', () => {
    const base = deliverableView(diagnosed);
    const again = buildFindingsChangeSet({
      model: diagnosed,
      candidates: runDetectors(base),
      at: AT,
      summary: 'Diagnostic',
    });
    expect(again.changeSet).toBeNull();
  });
});
