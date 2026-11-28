import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyChangeSet,
  buildActivity,
  buildFinding,
  buildModel,
  resetTestIds,
  type BusinessModel,
} from '@processia/model';
import { buildFindingsChangeSet } from './build.js';
import { runDetectors } from './detectors.js';
import type { FindingCandidate } from './types.js';

const AT = '2026-11-28T10:00:00.000Z';

let task = buildActivity();
let model: BusinessModel;

beforeEach(() => {
  resetTestIds();
  const macro = buildActivity({ level: 'macro' });
  const proc = buildActivity({ level: 'process', parentId: macro.id });
  task = buildActivity({ level: 'task', parentId: proc.id });
  model = buildModel([macro, proc, task]);
});

const candidate = (over: Partial<FindingCandidate> = {}): FindingCandidate => ({
  type: 'task_without_owner',
  family: 'organisation',
  location: [task.id],
  severity: 2,
  label: 'Constat',
  evidence: 'Parce que.',
  detection: { by: 'rule', detectorId: 'task_without_owner' },
  ...over,
});

describe('buildFindingsChangeSet', () => {
  it('écrit les constats d’un détecteur en hypothèse, origine deterministic_rule', () => {
    const built = buildFindingsChangeSet({
      model,
      candidates: runDetectors(model),
      at: AT,
      summary: 'Diagnostic',
    });
    expect(built.created).toBe(1);
    const applied = applyChangeSet(model, built.changeSet!, { at: AT, actor: 'system' });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const finding = Object.values(applied.model.elements).find((e) => e.kind === 'finding');
    expect(finding?.status.value).toBe('hypothesis');
    expect(finding?.provenance.origin).toBe('deterministic_rule');
    expect(finding?.provenance.author.type).toBe('system');
    expect(finding?.code).toMatch(/^CST/);
  });

  it('écrit les constats de l’IA en hypothèse, origine ai_knowledge, jamais un fait', () => {
    const built = buildFindingsChangeSet({
      model,
      candidates: [
        candidate({ type: 'bottleneck', family: 'flow_and_delay', detection: { by: 'ai' } }),
      ],
      at: AT,
      aiCallId: 'call-1',
      summary: 'Diagnostic',
    });
    const add = built.changeSet?.ops[0];
    expect(add?.op === 'add' && add.element.provenance).toMatchObject({
      origin: 'ai_knowledge',
      aiCallId: 'call-1',
      author: { type: 'ai' },
    });
    expect(add?.op === 'add' && add.element.status.value).toBe('hypothesis');
  });

  it('ne reproduit ni un constat présent, ni un constat rejeté, ni un doublon du lot', () => {
    const present = buildFinding({ type: 'task_without_owner', location: [task.id] });
    const withPresent = buildModel([...Object.values(model.elements), present]);
    expect(
      buildFindingsChangeSet({
        model: withPresent,
        candidates: [candidate()],
        at: AT,
        summary: 's',
      }),
    ).toMatchObject({ changeSet: null, duplicates: 1, created: 0 });
    const rejected = buildModel(Object.values(model.elements), {
      rejectedHypotheses: [{ element: present, by: 'user-1', at: AT }],
    });
    expect(
      buildFindingsChangeSet({ model: rejected, candidates: [candidate()], at: AT, summary: 's' })
        .changeSet,
    ).toBeNull();
    const twice = buildFindingsChangeSet({
      model,
      candidates: [candidate(), candidate()],
      at: AT,
      summary: 's',
    });
    expect(twice).toMatchObject({ created: 1, duplicates: 1 });
  });

  it('ignore un constat localisé sur un élément qui n’existe pas', () => {
    const built = buildFindingsChangeSet({
      model,
      candidates: [
        candidate({ location: ['01900000-ffff-7000-8000-0000000000aa'] }),
        candidate({ location: [] }),
      ],
      at: AT,
      summary: 's',
    });
    expect(built).toMatchObject({ changeSet: null, unlocated: 2, created: 0 });
  });
});
