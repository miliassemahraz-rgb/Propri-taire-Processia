import { beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_CAPABILITIES } from '../catalog/index.js';
import { isUuidV7 } from '../ids.js';
import { parseModel } from '../parse.js';
import { CORPUS, cloneMinimal } from '../testing/corpus.js';
import {
  buildActivity,
  buildActor,
  buildBusinessTrait,
  buildDataField,
  buildDataObject,
  buildDiscrepancy,
  buildEvent,
  buildFinding,
  buildGateway,
  buildGlossaryTerm,
  buildIndicator,
  buildInformationFlow,
  buildModel,
  buildOptimisation,
  buildProcessLink,
  buildProvenance,
  buildRule,
  buildSequenceFlow,
  buildSourceRef,
  buildStatus,
  buildTool,
  resetTestIds,
  testId,
} from '../testing/factories.js';
import { buildMinimalModel } from '../testing/minimal-model.js';
import { ActivitySchema } from './activity.js';
import { BusinessModelSchema } from './business-model.js';
import { ChangeSetSchema, ModelOpSchema } from './change-set.js';
import { ElementSchema } from './element.js';
import { ELEMENT_KINDS, CONCEPT_OF_KIND } from './kinds.js';
import { ProvenanceSchema } from './provenance.js';
import {
  OptimisationDecisionSchema,
  PostValidationNoticeSchema,
  ValidationSubmissionSchema,
} from './validation.js';

beforeEach(() => {
  resetTestIds();
});

describe('critère 1 : un modèle valide couvre tous les types d’éléments', () => {
  it('le modèle minimal est valide et contient les 16 types', () => {
    const result = parseModel(buildMinimalModel());
    expect(result.ok).toBe(true);
    const kinds = new Set(Object.values(buildMinimalModel().elements).map((e) => e.kind));
    expect([...kinds].sort()).toEqual([...ELEMENT_KINDS].sort());
  });

  it('chaque fabrique produit un élément valide', () => {
    const elements = [
      buildBusinessTrait(),
      buildGlossaryTerm(),
      buildActor(),
      buildActivity(),
      buildEvent(),
      buildGateway(),
      buildSequenceFlow(),
      buildProcessLink(),
      buildDataObject({ fields: [buildDataField()] }),
      buildTool(),
      buildInformationFlow(),
      buildRule(),
      buildIndicator(),
      buildDiscrepancy(),
      buildFinding(),
      buildOptimisation(),
    ];
    for (const e of elements) {
      expect(ElementSchema.safeParse(e).success, e.kind).toBe(true);
    }
    expect(BusinessModelSchema.safeParse(buildModel(elements)).success).toBe(true);
  });

  it('le modèle vide est valide', () => {
    expect(parseModel(buildModel()).ok).toBe(true);
  });

  it('CONCEPT_OF_KIND couvre tous les types sauf discrepancy, finding et optimisation', () => {
    expect(Object.keys(CONCEPT_OF_KIND).sort()).toEqual(
      ELEMENT_KINDS.filter((k) => !['discrepancy', 'finding', 'optimisation'].includes(k)).sort(),
    );
  });

  it('le fichier de fixture correspond au modèle minimal', async () => {
    const { readFileSync } = await import('node:fs');
    const url = new URL('../../fixtures/minimal-model.json', import.meta.url);
    expect(JSON.parse(readFileSync(url, 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(buildMinimalModel())),
    );
  });
});

describe('critère 2 : les modèles invalides sont rejetés avec un chemin', () => {
  for (const c of CORPUS) {
    it(`${c.valid ? 'accepte' : 'rejette'} : ${c.name}`, () => {
      const result = parseModel(c.mutate(cloneMinimal()));
      expect(result.ok).toBe(c.valid);
      if (!result.ok && c.pathEndsWith) {
        const paths = result.errors.map((e) => e.path);
        expect(
          paths.some((p) => p === c.pathEndsWith || p.endsWith(`.${c.pathEndsWith}`)),
          `chemins : ${paths.join(' | ')}`,
        ).toBe(true);
      }
    });
  }

  it('le chemin d’une erreur désigne l’élément fautif', () => {
    const m = cloneMinimal();
    const trait = Object.values(m.elements).find((e) => e.kind === 'business_trait');
    if (!trait) throw new Error('trait absent');
    trait.provenance.refs = [];
    const result = parseModel(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe(`elements.${trait.id}.provenance.refs`);
      expect(result.errors[0]?.message).toMatch(/référence de source/);
    }
  });

  it('refuse un élément dont l’id diffère de sa clé', () => {
    const m = cloneMinimal();
    const [key, element] = Object.entries(m.elements)[0] ?? [];
    if (!key || !element) throw new Error('modèle vide');
    element.id = testId();
    const result = parseModel(m);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toBe(`elements.${key}.id`);
  });

  it('refuse un modèle qui n’est pas un objet', () => {
    expect(parseModel(null).ok).toBe(false);
    expect(parseModel('x').ok).toBe(false);
    expect(parseModel([]).ok).toBe(false);
    expect(parseModel({}).ok).toBe(false);
  });

  it('refuse une clé d’élément qui n’est pas un UUID v7', () => {
    const m = buildModel([buildActor()]);
    const actor = Object.values(m.elements)[0];
    const bad = { ...m, elements: { 'tmp:1': { ...actor, id: 'tmp:1' } } };
    expect(parseModel(bad).ok).toBe(false);
  });
});

describe('schémas unitaires', () => {
  it('Provenance : ai_knowledge exige rationale, autre origine non', () => {
    expect(ProvenanceSchema.safeParse(buildProvenance({ origin: 'ai_knowledge' })).success).toBe(
      false,
    );
    expect(
      ProvenanceSchema.safeParse(buildProvenance({ origin: 'ai_knowledge', rationale: 'ok' }))
        .success,
    ).toBe(true);
    expect(ProvenanceSchema.safeParse(buildProvenance({ origin: 'answer' })).success).toBe(true);
  });

  it('Activity : seul le macroprocessus peut être sans parent', () => {
    expect(ActivitySchema.safeParse(buildActivity({ level: 'macro' })).success).toBe(true);
    for (const level of ['process', 'task', 'step'] as const) {
      expect(ActivitySchema.safeParse(buildActivity({ level })).success, level).toBe(false);
      expect(ActivitySchema.safeParse(buildActivity({ level, parentId: testId() })).success).toBe(
        true,
      );
    }
  });

  it('Element : extracted exige une référence, hypothesis une justification', () => {
    const extractedNoRef = buildActor({ status: buildStatus({ value: 'extracted' }) });
    expect(ElementSchema.safeParse(extractedNoRef).success).toBe(false);
    const extracted = buildActor({
      status: buildStatus({ value: 'extracted' }),
      provenance: buildProvenance({ origin: 'document', refs: [buildSourceRef()] }),
    });
    expect(ElementSchema.safeParse(extracted).success).toBe(true);
    const hypo = buildActor({ status: buildStatus({ value: 'hypothesis' }) });
    expect(ElementSchema.safeParse(hypo).success).toBe(false);
  });

  it('Optimisation : au moins un constat, scores de 1 à 5', () => {
    expect(ElementSchema.safeParse(buildOptimisation({ findingIds: [] })).success).toBe(false);
    const o = buildOptimisation();
    expect(ElementSchema.safeParse({ ...o, effort: { ...o.effort, score: 6 } }).success).toBe(
      false,
    );
    expect(ElementSchema.safeParse({ ...o, gain: { ...o.gain, score: 0 } }).success).toBe(false);
  });

  it('Catalogue : les capacités du moteur sont acceptées, une autre non', () => {
    for (const cap of ENGINE_CAPABILITIES) {
      const a = buildActivity({
        automation: { type: cap.type, capability: cap.id },
      });
      expect(ActivitySchema.safeParse(a).success, cap.id).toBe(true);
    }
  });

  it('ModelOp et ChangeSet', () => {
    const element = buildActor({ id: 'tmp:1' });
    expect(ModelOpSchema.safeParse({ op: 'add', element }).success).toBe(true);
    expect(
      ModelOpSchema.safeParse({ op: 'update', id: testId(), set: { label: 'x' }, unset: ['tags'] })
        .success,
    ).toBe(true);
    expect(
      ModelOpSchema.safeParse({ op: 'remove', id: testId(), cascade: [testId()] }).success,
    ).toBe(true);
    expect(
      ModelOpSchema.safeParse({
        op: 'set_status',
        id: testId(),
        status: 'confirmed',
        correction: { a: 1 },
      }).success,
    ).toBe(true);
    expect(
      ModelOpSchema.safeParse({ op: 'reject_hypothesis', id: testId(), reason: 'non' }).success,
    ).toBe(true);
    expect(
      ModelOpSchema.safeParse({
        op: 'set_layout',
        diagram: 'L0',
        positions: { [testId()]: { x: 0, y: 0, w: 1, h: 1 } },
      }).success,
    ).toBe(true);
    expect(
      ModelOpSchema.safeParse({ op: 'set_layout', diagram: 'X9', positions: {} }).success,
    ).toBe(false);
    expect(ModelOpSchema.safeParse({ op: 'update', id: 'nope', set: {} }).success).toBe(false);
    const cs = { baseVersion: 3, ops: [], cause: 'dialogue_edit', summary: 'Rien' };
    expect(ChangeSetSchema.safeParse(cs).success).toBe(true);
    expect(ChangeSetSchema.safeParse({ ...cs, cause: 'magie' }).success).toBe(false);
    expect(ChangeSetSchema.safeParse({ ...cs, summary: '' }).success).toBe(false);
  });

  it('ValidationSubmission, OptimisationDecision, PostValidationNotice', () => {
    const submission = {
      id: 's1',
      missionId: 'm1',
      kind: 'as_is',
      round: 1,
      modelVersion: 4,
      artifactIds: [],
      excludedHypothesisIds: [],
      status: 'submitted',
      submittedBy: 'u1',
      submittedAt: '2026-01-15T09:00:00Z',
    };
    expect(ValidationSubmissionSchema.safeParse(submission).success).toBe(true);
    expect(ValidationSubmissionSchema.safeParse({ ...submission, kind: 'x' }).success).toBe(false);
    expect(ValidationSubmissionSchema.safeParse({ ...submission, round: 0 }).success).toBe(false);
    const decision = {
      id: 'd1',
      submissionId: 's1',
      optimisationId: testId(),
      value: 'rejected',
      cause: 'cascade',
      cascadeFrom: testId(),
      by: 'u1',
      at: '2026-01-15T09:00:00Z',
    };
    expect(OptimisationDecisionSchema.safeParse(decision).success).toBe(true);
    expect(OptimisationDecisionSchema.safeParse({ ...decision, value: 'maybe' }).success).toBe(
      false,
    );
    const notice = {
      id: 'n1',
      missionId: 'm1',
      submissionId: 's1',
      elementId: testId(),
      version: 5,
      summary: 'Libellé modifié',
      createdAt: '2026-01-15T09:00:00Z',
    };
    expect(PostValidationNoticeSchema.safeParse(notice).success).toBe(true);
    expect(PostValidationNoticeSchema.safeParse({ ...notice, summary: '' }).success).toBe(false);
  });

  it('les identifiants des fabriques sont des UUID v7', () => {
    expect(isUuidV7(testId())).toBe(true);
  });
});
