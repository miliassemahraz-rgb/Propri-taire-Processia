import { describe, expect, it } from 'vitest';
import { buildBusinessTrait, buildModel, buildStatus } from '@processia/model';
import {
  busyFormats,
  deliverableAnchor,
  isExportActive,
  mergeExportRun,
  pendingHypothesisCount,
  shortSha,
  type ExportRunState,
} from './deliverables';

const run = (over: Partial<ExportRunState> = {}): ExportRunState => ({
  runId: 'r1',
  format: 'docx',
  status: 'queued',
  progress: 0,
  ...over,
});

describe('livrables', () => {
  it('compte les hypothèses en attente de décision', () => {
    expect(pendingHypothesisCount(null)).toBe(0);
    const model = buildModel([
      buildBusinessTrait({ status: buildStatus({ value: 'hypothesis' }) }),
      buildBusinessTrait({ status: buildStatus({ value: 'hypothesis' }) }),
      buildBusinessTrait({ status: buildStatus({ value: 'extracted' }) }),
      buildBusinessTrait(),
    ]);
    expect(pendingHypothesisCount(model)).toBe(2);
  });

  it('abrège l’empreinte et nomme les ancres', () => {
    expect(shortSha('a'.repeat(64))).toBe(`${'a'.repeat(12)}…`);
    expect(shortSha('abc')).toBe('abc');
    expect(deliverableAnchor('rules_register')).toBe('livrable-rules_register');
  });

  it('suit une exécution d’export sans jamais la réactiver', () => {
    const start = { r1: run() };
    const running = mergeExportRun(start, { runId: 'r1', status: 'running', progress: 40 });
    expect(running['r1']).toMatchObject({ status: 'running', progress: 40 });
    const done = mergeExportRun(running, { runId: 'r1', status: 'succeeded', progress: 100 });
    expect(isExportActive(done['r1'] as ExportRunState)).toBe(false);
    // Un message tardif ne ramène pas l'exécution à l'état actif.
    expect(mergeExportRun(done, { runId: 'r1', status: 'running', progress: 50 })).toBe(done);
    // Une exécution d'un autre consultant (non suivie ici) est ignorée.
    expect(mergeExportRun(done, { runId: 'autre', status: 'running', progress: 1 })).toBe(done);
  });

  it('désactive uniquement les formats en cours de production', () => {
    const runs = {
      a: run({ runId: 'a', format: 'docx', status: 'running' }),
      b: run({ runId: 'b', format: 'pdf', status: 'succeeded' }),
    };
    expect([...busyFormats(runs)]).toEqual(['docx']);
  });
});
