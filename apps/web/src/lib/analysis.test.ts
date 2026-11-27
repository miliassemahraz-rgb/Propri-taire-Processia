import { describe, expect, it } from 'vitest';
import type { RunProgressMessage } from '@processia/contracts';
import {
  buildActivity,
  buildActor,
  buildDiscrepancy,
  buildModel,
  buildSourceRef,
  buildStatus,
  buildTool,
} from '@processia/model';
import {
  applyRunMessage,
  citationCountBySource,
  elementsByTab,
  openDiscrepancies,
  statusCounts,
  type ExtractionRunState,
} from './analysis';

function message(over: Partial<RunProgressMessage> = {}): RunProgressMessage {
  return {
    type: 'run.progress',
    missionId: 'm',
    runId: 'r1',
    kind: 'extraction',
    status: 'running',
    progress: 40,
    sourceId: 's1',
    error: null,
    ...over,
  };
}

describe('regroupement des éléments par onglet', () => {
  it('range chaque élément dans son concept, trie par code naturel et isole les écarts', () => {
    const model = buildModel([
      buildActivity({ code: 'P04.10', label: 'Dixième' }),
      buildActivity({ code: 'P04.2', label: 'Deuxième' }),
      buildActor({ code: 'ACT1' }),
      buildTool({ code: 'OUT1' }),
      buildDiscrepancy({ code: 'ECA1' }),
    ]);
    const tabs = elementsByTab(model);
    expect(tabs.activities.map((e) => e.code)).toEqual(['P04.2', 'P04.10']);
    expect(tabs.actors).toHaveLength(1);
    expect(tabs.data).toHaveLength(1);
    expect(tabs.discrepancies).toHaveLength(1);
    expect(tabs.rules).toHaveLength(0);
    expect(elementsByTab(null).activities).toEqual([]);
  });

  it('compte les statuts et les écarts ouverts', () => {
    const model = buildModel([
      buildActor({ code: 'A1' }),
      buildActor({ code: 'A2', status: buildStatus({ value: 'hypothesis' }) }),
      buildDiscrepancy({ code: 'E1', state: 'open' }),
      buildDiscrepancy({
        code: 'E2',
        state: 'resolved',
        resolution: { note: 'ok', by: 'u', at: '2026-01-01T00:00:00.000Z' },
      }),
    ]);
    const counts = statusCounts(elementsByTab(model).actors);
    expect(counts.hypothesis).toBe(1);
    expect(counts.extracted + counts.confirmed + counts.validated).toBe(
      elementsByTab(model).actors.length - 1,
    );
    expect(openDiscrepancies(model).map((d) => d.code)).toEqual(['E1']);
  });

  it('compte les éléments qui citent chaque source, écarts compris', () => {
    const ref = buildSourceRef({ sourceId: 'src-a' });
    const other = buildSourceRef({ sourceId: 'src-b' });
    const model = buildModel([
      buildActor({
        code: 'A1',
        status: buildStatus({ value: 'extracted' }),
        provenance: {
          origin: 'free_text',
          refs: [ref, ref],
          author: { type: 'ai' },
          at: '2026-01-01T00:00:00.000Z',
        },
      }),
      buildDiscrepancy({
        code: 'E1',
        sides: [
          { claim: 'a', refs: [ref] },
          { claim: 'b', refs: [other] },
        ],
      }),
    ]);
    const counts = citationCountBySource(model);
    expect(counts.get('src-a')).toBe(2);
    expect(counts.get('src-b')).toBe(1);
    expect(citationCountBySource(null).size).toBe(0);
  });
});

describe('suivi de l’extraction', () => {
  it('ignore les messages d’un autre genre de tâche', () => {
    expect(applyRunMessage(null, message({ kind: 'ingest' }))).toBeNull();
  });

  it('suit la progression puis le résultat', () => {
    const running = applyRunMessage(null, message());
    expect(running).toMatchObject({ runId: 'r1', status: 'running', progress: 40 });
    const done = applyRunMessage(running, message({ status: 'succeeded', progress: 100 }));
    expect(done).toMatchObject({ status: 'succeeded', progress: 100 });
  });

  it('un message tardif ne ranime pas une exécution terminée', () => {
    const done: ExtractionRunState = {
      runId: 'r1',
      status: 'succeeded',
      progress: 100,
      error: null,
      sourceId: 's1',
    };
    expect(applyRunMessage(done, message({ status: 'running', progress: 80 }))).toBe(done);
    expect(applyRunMessage(done, message({ runId: 'r2' }))?.runId).toBe('r2');
  });
});
