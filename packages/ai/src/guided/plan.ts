import {
  completeness,
  CONCEPTS,
  type BusinessModel,
  type Concept,
  type BusinessTrait,
  type ChangeSet,
  type Element,
} from '@processia/model';
import {
  matchExisting,
  mergeCandidates,
  type VerifiedCandidate,
} from '../extraction/candidates.js';
import { buildExtractionChangeSet, type BuildResult } from '../extraction/changeset.js';
import {
  hypothesisKey,
  type HypothesesInput,
  type HypothesesOutput,
  type QuestionsInput,
  type SummaryOutput,
} from '../pipelines/guided.js';

/** Plafond de manques transmis par concept (le rapport complet reste visible dans l'interface). */
const MAX_GAPS_PER_CONCEPT = 100;

type Gap = ReturnType<typeof completeness>[Concept]['gaps'][number];

/** Manques triés par code d'élément (ordre naturel : `P04.2` avant `P04.10`), plafonnés. */
function sortedGaps(model: BusinessModel, gaps: Gap[]): Gap[] {
  const codeOf = (gap: Gap): string =>
    gap.elementId === undefined ? '' : (model.elements[gap.elementId]?.code ?? '');
  return [...gaps]
    .sort((a, b) => codeOf(a).localeCompare(codeOf(b), 'fr', { numeric: true }))
    .slice(0, MAX_GAPS_PER_CONCEPT);
}

/** Entrée de `questions` : complétude par concept, écarts ouverts, résumé du modèle (CDC 3.2). */
export function buildQuestionsInput(
  model: BusinessModel,
  summary: QuestionsInput['model'],
  asked: string[],
): QuestionsInput {
  const report = completeness(model);
  const els = Object.values(model.elements);
  return {
    report: CONCEPTS.map((concept) => ({
      concept,
      score: Math.round(report[concept].score * 100) / 100,
      gaps: sortedGaps(model, report[concept].gaps).map((gap) => {
        const target = gap.elementId === undefined ? undefined : model.elements[gap.elementId];
        return {
          check: gap.check,
          message: gap.message,
          ...(target === undefined ? {} : { elementCode: target.code, elementLabel: target.label }),
        };
      }),
      pendingHypotheses: report[concept].pendingHypotheses,
      openQuestions: report[concept].openQuestions,
    })),
    discrepancies: els.flatMap((e) =>
      e.kind === 'discrepancy' && e.state === 'open'
        ? [
            {
              label: e.label,
              elementCodes: e.elementIds.flatMap((id) => {
                const code = model.elements[id]?.code;
                return code === undefined ? [] : [code];
              }),
            },
          ]
        : [],
    ),
    model: summary,
    asked,
  };
}

/** Entrée de `hypotheses` : résumé, manques et hypothèses archivées à ne pas reproposer. */
export function buildHypothesesInput(
  model: BusinessModel,
  summary: HypothesesInput['model'],
): HypothesesInput {
  const report = completeness(model);
  return {
    model: summary,
    gaps: CONCEPTS.flatMap((concept) =>
      sortedGaps(model, report[concept].gaps).map((gap) => ({
        concept,
        check: gap.check,
        message: gap.message,
      })),
    ),
    rejected: model.rejectedHypotheses.map((r) => ({
      kind: r.element.kind,
      label: r.element.label,
    })),
  };
}

/**
 * ChangeSet `hypotheses` : les propositions deviennent des éléments `hypothesis` (origine
 * `ai_knowledge`, justification obligatoire, aucune citation). Une proposition qui répète une
 * hypothèse rejetée est écartée ici même si le contrôle sémantique l'a laissée passer, et une
 * proposition déjà présente dans le modèle n'est pas dupliquée.
 */
export function buildHypothesesChangeSet(input: {
  model: BusinessModel;
  output: HypothesesOutput;
  aiCallId: string | null;
  at: string;
}): BuildResult & { rejectedSkipped: number } {
  const { model, output } = input;
  const rejected = new Set(
    model.rejectedHypotheses.map((r) => hypothesisKey(r.element.kind, r.element.label)),
  );
  let rejectedSkipped = 0;
  const refs = new Set(output.proposals.map((p) => p.ref));
  const candidates: VerifiedCandidate[] = [];
  for (const p of output.proposals) {
    if (rejected.has(hypothesisKey(p.kind, p.label))) {
      rejectedSkipped += 1;
      continue;
    }
    const parent = p.activity?.parent;
    candidates.push({
      key: `h:${p.ref}`,
      kind: p.kind,
      label: p.label.trim(),
      ...(p.code === undefined ? {} : { code: p.code }),
      ...(p.description === undefined ? {} : { description: p.description }),
      ...(p.trait === undefined ? {} : { trait: p.trait }),
      ...(p.actor === undefined ? {} : { actor: p.actor }),
      ...(p.activity === undefined ? {} : { activity: p.activity }),
      ...(p.tool === undefined ? {} : { tool: p.tool }),
      ...(p.term === undefined ? {} : { term: p.term }),
      ...(parent !== undefined && refs.has(parent) ? { parentKey: `h:${parent}` } : {}),
      refs: [],
      quote: null,
      rationale: p.rationale,
      ...(p.confidence === undefined ? {} : { confidence: p.confidence }),
      demoted: false,
      inferred: true,
      origin: 'free_text',
      aiCallId: input.aiCallId,
    });
  }
  const merged = mergeCandidates(candidates);
  const matches = matchExisting(merged.candidates, merged.mergedInto, model);
  const built = buildExtractionChangeSet({
    model,
    candidates: merged.candidates,
    mergedInto: merged.mergedInto,
    matches,
    discrepancies: [],
    at: input.at,
    cause: 'hypotheses',
    summary: `Hypothèses : ${merged.candidates.length - matches.size} proposée(s)`,
  });
  return { ...built, rejectedSkipped };
}

/** Caractéristiques du métier utilisables pour la synthèse : jamais les hypothèses (CDC 3.1). */
export function summaryTraits(model: BusinessModel): BusinessTrait[] {
  return Object.values(model.elements)
    .filter(
      (e: Element): e is BusinessTrait =>
        e.kind === 'business_trait' &&
        e.facet !== 'summary' &&
        (e.status.value === 'confirmed' ||
          e.status.value === 'validated' ||
          e.status.value === 'extracted'),
    )
    .sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }));
}

export const SUMMARY_LABEL = 'Synthèse du métier';

export type SummaryBuild =
  | { changeSet: ChangeSet; existingId: string | null }
  | { changeSet: null; reason: 'SUMMARY_DECIDED' };

/**
 * ChangeSet de la synthèse : une hypothèse de facette `summary` à confirmer. Une synthèse déjà
 * décidée (confirmée, validée ou extraite d'une source) n'est jamais écrasée ; une hypothèse
 * de synthèse en attente est remplacée par la nouvelle rédaction.
 */
export function buildSummaryChangeSet(input: {
  model: BusinessModel;
  output: SummaryOutput;
  aiCallId: string | null;
  at: string;
}): SummaryBuild {
  const { model, output, at } = input;
  const existing = Object.values(model.elements).find(
    (e): e is BusinessTrait => e.kind === 'business_trait' && e.facet === 'summary',
  );
  const provenance = {
    origin: 'ai_knowledge' as const,
    refs: [],
    rationale: output.rationale,
    ...(input.aiCallId === null ? {} : { aiCallId: input.aiCallId }),
    author: { type: 'ai' as const },
    at,
  };
  if (existing !== undefined) {
    if (existing.status.value !== 'hypothesis') {
      return { changeSet: null, reason: 'SUMMARY_DECIDED' };
    }
    return {
      existingId: existing.id,
      changeSet: {
        baseVersion: model.version,
        cause: 'hypotheses',
        summary: 'Synthèse du métier réécrite (hypothèse)',
        ops: [{ op: 'update', id: existing.id, set: { text: output.text.trim(), provenance } }],
      },
    };
  }
  return {
    existingId: null,
    changeSet: {
      baseVersion: model.version,
      cause: 'hypotheses',
      summary: 'Synthèse du métier proposée (hypothèse)',
      ops: [
        {
          op: 'add',
          element: {
            id: 'tmp:1',
            kind: 'business_trait',
            code: '',
            label: SUMMARY_LABEL,
            facet: 'summary',
            text: output.text.trim(),
            provenance,
            status: { value: 'hypothesis' },
            meta: { createdInVersion: 0, updatedInVersion: 0 },
          },
        },
      ],
    },
  };
}
