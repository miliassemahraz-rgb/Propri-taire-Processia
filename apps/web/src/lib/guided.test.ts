import { describe, expect, it } from 'vitest';
import type { QuestionDto, RunProgressMessage } from '@processia/contracts';
import {
  buildActivity,
  buildActor,
  buildBusinessTrait,
  buildDiscrepancy,
  buildGlossaryTerm,
  buildModel,
  buildStatus,
} from '@processia/model';
import {
  activeRun,
  applyGuidedRun,
  blockingConcepts,
  buildCorrection,
  canSummarize,
  correctableFields,
  correctionDefaults,
  elementDetail,
  openQuestions,
  pendingHypotheses,
  type GuidedRunState,
} from './guided';

const hypothesis = () => buildStatus({ value: 'hypothesis' });

function message(over: Partial<RunProgressMessage> = {}): RunProgressMessage {
  return {
    type: 'run.progress',
    missionId: 'm',
    runId: 'r1',
    kind: 'questions',
    status: 'running',
    progress: 30,
    sourceId: null,
    error: null,
    ...over,
  };
}

function question(over: Partial<QuestionDto> = {}): QuestionDto {
  return {
    id: 'q1',
    concept: 'rules',
    text: 'Qui valide ?',
    rationale: null,
    blockingScore: 50,
    targetElementIds: [],
    status: 'open',
    answerSourceId: null,
    answeredBy: null,
    rank: 1,
    createdAt: '2026-11-27T10:00:00.000Z',
    ...over,
  };
}

describe('suivi des exécutions guidées', () => {
  it('ne suit que les genres demandés et ignore l’extraction', () => {
    let runs: Record<string, GuidedRunState> = {};
    runs = applyGuidedRun(runs, message({ kind: 'extraction' }));
    expect(runs).toEqual({});
    runs = applyGuidedRun(runs, message({ kind: 'hypotheses' }), ['questions']);
    expect(runs).toEqual({});
    runs = applyGuidedRun(runs, message());
    expect(runs['r1']).toMatchObject({ kind: 'questions', progress: 30 });
    expect(activeRun(runs, 'questions')?.runId).toBe('r1');
    expect(activeRun(runs, 'answer')).toBeNull();
  });

  it('un message tardif ne ramène pas une exécution terminée à l’état actif', () => {
    let runs = applyGuidedRun({}, message({ status: 'succeeded', progress: 100 }));
    runs = applyGuidedRun(runs, message({ status: 'running', progress: 60 }));
    expect(runs['r1']).toMatchObject({ status: 'succeeded', progress: 100 });
    expect(activeRun(runs, 'questions')).toBeNull();
  });
});

describe('questions', () => {
  it('ne garde que les questions ouvertes, la plus bloquante (rang 1) d’abord', () => {
    const list = [
      question({ id: 'b', rank: 2 }),
      question({ id: 'done', status: 'answered', rank: null }),
      question({ id: 'a', rank: 1 }),
    ];
    expect(openQuestions(list).map((q) => q.id)).toEqual(['a', 'b']);
  });

  it('les concepts bloqués sont celui de la question puis ceux des éléments visés', () => {
    const activity = buildActivity({ id: 'act-1' });
    const model = buildModel([activity]);
    expect(blockingConcepts(question({ targetElementIds: ['act-1'] }), model)).toEqual([
      'rules',
      'activities',
    ]);
    expect(
      blockingConcepts(question({ concept: 'activities', targetElementIds: ['act-1'] }), model),
    ).toEqual(['activities']);
    expect(blockingConcepts(question({ targetElementIds: ['inconnu'] }), null)).toEqual(['rules']);
  });
});

describe('hypothèses', () => {
  it('liste les hypothèses par concept puis par code, sans les écarts ni les éléments décidés', () => {
    const model = buildModel([
      buildActivity({ id: 'a2', code: 'P01.2', status: hypothesis() }),
      buildActor({ id: 'ac', code: 'ACT-01', status: hypothesis() }),
      buildActivity({ id: 'a1', code: 'P01.1', status: hypothesis() }),
      buildActivity({ id: 'ok', code: 'P01.3', status: buildStatus({ value: 'confirmed' }) }),
      buildDiscrepancy({ id: 'd', status: hypothesis() }),
    ]);
    expect(pendingHypotheses(model).map((e) => e.id)).toEqual(['ac', 'a1', 'a2']);
    expect(pendingHypotheses(null)).toEqual([]);
  });

  it('affiche le contenu principal selon la nature', () => {
    expect(elementDetail(buildBusinessTrait({ text: 'Pic en mars' }))).toBe('Pic en mars');
    expect(elementDetail(buildGlossaryTerm({ definition: 'Liasse' }))).toBe('Liasse');
    expect(elementDetail(buildActor({ responsibilities: ['A', 'B'] }))).toBe('A ; B');
    expect(elementDetail(buildActivity({ description: 'Texte' }))).toBe('Texte');
  });

  it('le formulaire de correction ne porte que les attributs textuels de l’analyse [PO-5]', () => {
    expect(correctableFields('business_trait')).toEqual(['label', 'text', 'description']);
    expect(correctableFields('activity')).toEqual(['label', 'description']);
    expect(correctableFields('sequence_flow')).toEqual([]);
    expect(correctableFields('discrepancy')).toEqual([]);
  });

  it('envoie seulement les champs modifiés, et les responsabilités ligne par ligne', () => {
    const actor = buildActor({
      label: 'Chef',
      responsibilities: ['Coordination'],
      status: hypothesis(),
    });
    const values = correctionDefaults(actor);
    expect(buildCorrection(actor, values)).toEqual({});
    expect(
      buildCorrection(actor, {
        ...values,
        label: ' Chef de mission ',
        responsibilities: 'Coordination\n\n Planification ',
      }),
    ).toEqual({ label: 'Chef de mission', responsibilities: ['Coordination', 'Planification'] });
    const trait = buildBusinessTrait({ text: 'A', description: 'D' });
    expect(buildCorrection(trait, { ...correctionDefaults(trait), description: '' })).toEqual({
      description: '',
    });
  });

  it('la synthèse exige une caractéristique non hypothétique', () => {
    expect(canSummarize(null)).toBe(false);
    expect(canSummarize(buildModel([buildBusinessTrait({ status: hypothesis() })]))).toBe(false);
    expect(canSummarize(buildModel([buildBusinessTrait({ facet: 'summary' })]))).toBe(false);
    expect(
      canSummarize(
        buildModel([
          buildBusinessTrait({ facet: 'sector', status: buildStatus({ value: 'extracted' }) }),
        ]),
      ),
    ).toBe(true);
  });
});
