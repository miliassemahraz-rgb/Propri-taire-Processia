import {
  buildActivity,
  buildActor,
  buildGateway,
  buildInformationFlow,
  buildModel,
  resetTestIds,
  type Activity,
  type BusinessModel,
} from '@processia/model';
import { PILOT_DIAGNOSTIC_SCENARIOS, type ScenarioRequest } from '@processia/test-fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeProvider, type FakeScenario } from '../fake-provider.js';
import { checkDiagnostic, diagnosticPipeline } from '../pipelines/diagnostic.js';
import { runPipeline } from '../runner.js';
import { buildDiagnosticInput, listDiagnosticMacros, resolveDiagnosticOutput } from './plan.js';

const fake = new FakeProvider({
  scenarios: PILOT_DIAGNOSTIC_SCENARIOS as Record<string, FakeScenario>,
});
const deps = { provider: fake };
const ctx = { clientId: 'client' };

let model: BusinessModel;
let macro: Activity;
let relance: Activity;
let other: Activity;

beforeEach(() => {
  resetTestIds();
  macro = buildActivity({ level: 'macro', label: 'Collecte documentaire' });
  const proc = buildActivity({ level: 'process', parentId: macro.id, label: 'Relances clients' });
  const actor = buildActor({ label: 'Assistant administratif' });
  relance = buildActivity({
    level: 'task',
    parentId: proc.id,
    label: 'Relance des pièces manquantes',
    responsibleActorId: actor.id,
  });
  other = buildActivity({ level: 'task', parentId: proc.id, label: 'Classer' });
  const gw = buildGateway({ containerId: proc.id });
  const flow = buildInformationFlow({
    fromActorId: actor.id,
    toActorId: actor.id,
    channel: 'email',
    activityId: relance.id,
  });
  const emptyMacro = buildActivity({ level: 'macro', label: 'Sans tâche' });
  model = buildModel([macro, proc, actor, relance, other, gw, flow, emptyMacro]);
});

describe('diagnostic : entrée et résolution', () => {
  it('ne liste que les macroprocessus qui ont des tâches', () => {
    expect(listDiagnosticMacros(model).map((m) => m.code)).toEqual([macro.code]);
  });

  it('réduit l’entrée au macroprocessus et y passe les constats déjà trouvés', () => {
    const input = buildDiagnosticInput(model, macro.id, [
      { type: 'paper_or_email_transfer', location: [relance.id] },
      { type: 'rekeying', location: ['hors-portee'] },
    ]);
    expect(input.macro.code).toBe(macro.code);
    expect(input.activities.map((a) => a.code)).toContain(relance.code);
    expect(input.informationFlows).toHaveLength(1);
    expect(input.known).toEqual([{ type: 'paper_or_email_transfer', locations: [relance.code] }]);
  });

  it('le scénario factice produit des constats localisés sur des codes de l’entrée', async () => {
    const input = buildDiagnosticInput(model, macro.id);
    const output = await runPipeline(diagnosticPipeline, input, ctx, deps);
    expect(output.findings.length).toBeGreaterThan(0);
    expect(checkDiagnostic(output, input)).toEqual([]);
    const resolved = resolveDiagnosticOutput(model, macro.id, output);
    expect(resolved).toHaveLength(output.findings.length);
    for (const finding of resolved) {
      expect(finding.detection.by).toBe('ai');
      expect(finding.location.every((id) => model.elements[id] !== undefined)).toBe(true);
    }
    expect(resolved.map((f) => f.type)).toEqual(['waiting_time', 'repetitive_task']);
    expect(resolved[0]?.location).toEqual([relance.id]);
    expect(other.code).toBeDefined();
  });

  it('le scénario ne reproduit pas un constat déjà connu', async () => {
    const known = [{ type: 'waiting_time', location: [relance.id] }];
    const output = await runPipeline(
      diagnosticPipeline,
      buildDiagnosticInput(model, macro.id, known),
      ctx,
      deps,
    );
    expect(output.findings.map((f) => f.type)).toEqual(['repetitive_task']);
  });

  it('refuse une localisation qui n’est pas dans le macroprocessus', () => {
    const input = buildDiagnosticInput(model, macro.id);
    const issues = checkDiagnostic(
      {
        findings: [
          { type: 'bottleneck', location: ['P99.9'], severity: 1, label: 'x', evidence: 'y' },
        ],
        rationale: 'r',
      },
      input,
    );
    expect(issues).toHaveLength(1);
    const dropped = resolveDiagnosticOutput(model, macro.id, {
      findings: [
        { type: 'bottleneck', location: ['P99.9'], severity: 1, label: 'x', evidence: 'y' },
      ],
      rationale: 'r',
    });
    expect(dropped).toEqual([]);
  });

  it('un scénario inconnu du pipeline reste valide (aucun constat)', () => {
    const req = { messages: [{ role: 'user', content: 'rien' }] } as unknown as ScenarioRequest;
    expect(PILOT_DIAGNOSTIC_SCENARIOS['diagnostic']?.(req)).toMatchObject({ findings: [] });
  });
});
