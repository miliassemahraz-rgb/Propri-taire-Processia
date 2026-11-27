import { CONCEPTS, type Concept } from '@processia/model';
import { z } from 'zod';
import { normalizeForMatch } from '../extraction/text.js';
import { loadPrompt } from '../prompts.js';
import type { PipelineDef } from '../runner.js';
import {
  chunkMessage,
  DONNEES_CLOSE,
  DONNEES_OPEN,
  extractionCandidateSchema,
  extractionCandidatesSchema,
  extractionChunkPipeline,
  summaryContext,
  type CandidateKind,
  type ChunkInput,
  type ExtractionCandidates,
  type ModelSummaryEntry,
} from './extraction.js';

const text = z.string().min(1);
const norm = normalizeForMatch;

/** Message de données entouré de balises : le contenu est une donnée, jamais une consigne. */
const donnees = (value: unknown): string =>
  `${DONNEES_OPEN}\n${JSON.stringify(value)}\n${DONNEES_CLOSE}`;

// ------------------------------------------------------------------ questions

/** Un manque de complétude présenté à `questions`. */
export interface QuestionGap {
  check: string;
  message: string;
  /** Code de l'élément concerné, le cas échéant. */
  elementCode?: string;
  elementLabel?: string;
}

export interface QuestionsInput {
  /** Rapport de complétude par concept (CDC 3.7). */
  report: {
    concept: Concept;
    score: number;
    gaps: QuestionGap[];
    pendingHypotheses: number;
    openQuestions: number;
  }[];
  /** Écarts ouverts entre sources (libellé et codes des éléments concernés). */
  discrepancies: { label: string; elementCodes: string[] }[];
  model: ModelSummaryEntry[];
  /** Textes des questions déjà posées (ouvertes, répondues ou passées). */
  asked: string[];
}

export const questionSchema = z.object({
  text,
  concept: z.enum(CONCEPTS),
  /** Codes des éléments visés (résumé du modèle). */
  targetCodes: z.array(text),
  /** 0 à 100 : à quel point la réponse débloque la suite (CDC 3.2 §3). */
  blockingScore: z.number().int().min(0).max(100),
  rationale: text,
});
export type QuestionProposal = z.infer<typeof questionSchema>;

export const questionsOutputSchema = z.object({ questions: z.array(questionSchema).max(12) });
export type QuestionsOutput = z.infer<typeof questionsOutputSchema>;

/** `questions` (spécification 4.4) : questions classées par effet bloquant. */
export const questionsPipeline: PipelineDef<QuestionsInput, QuestionsOutput> = {
  name: 'questions',
  version: '1',
  schemaName: 'Questions',
  outputSchema: questionsOutputSchema,
  buildRequest: (input) => ({
    system: loadPrompt('questions'),
    context: summaryContext(input.model),
    messages: [
      {
        role: 'user',
        content: donnees({
          report: input.report,
          discrepancies: input.discrepancies,
          asked: input.asked,
        }),
      },
    ],
    maxOutputTokens: 8_000,
    effort: 'medium',
  }),
  semanticCheck: (output, input) => {
    const issues: { path: string; message: string }[] = [];
    const codes = new Set(input.model.map((e) => e.code));
    const asked = new Set(input.asked.map(norm));
    const seen = new Set<string>();
    output.questions.forEach((q, i) => {
      const at = `questions.${i}`;
      q.targetCodes.forEach((code, j) => {
        if (!codes.has(code)) {
          issues.push({ path: `${at}.targetCodes.${j}`, message: `Code inconnu : ${code}.` });
        }
      });
      const key = norm(q.text);
      if (asked.has(key)) {
        issues.push({ path: `${at}.text`, message: 'Question déjà posée : ne pas la reposer.' });
      }
      if (seen.has(key)) issues.push({ path: `${at}.text`, message: 'Question en double.' });
      seen.add(key);
    });
    return issues;
  },
};

/** Question prête à être enregistrée (cibles résolues, classée). */
export interface RankedQuestion {
  text: string;
  concept: Concept;
  rationale: string;
  blockingScore: number;
  targetCodes: string[];
}

/**
 * Classement déterministe des questions : effet bloquant décroissant (le plus bloquant d'abord),
 * puis ordre de la réponse. Écarte celles qui répètent une question déjà posée.
 */
export function rankQuestions(output: QuestionsOutput, asked: string[]): RankedQuestion[] {
  const known = new Set(asked.map(norm));
  const kept: RankedQuestion[] = [];
  for (const q of output.questions) {
    const key = norm(q.text);
    if (known.has(key)) continue;
    known.add(key);
    kept.push({
      text: q.text.trim(),
      concept: q.concept,
      rationale: q.rationale,
      blockingScore: q.blockingScore,
      targetCodes: q.targetCodes,
    });
  }
  return kept
    .map((q, i) => ({ q, i }))
    .sort((a, b) => b.q.blockingScore - a.q.blockingScore || a.i - b.i)
    .map((x) => x.q);
}

// ------------------------------------------------------------------ answer.integrate

export interface AnswerIntegrateInput {
  question: { text: string; concept: string };
  /** Résumé du modèle (éléments connus, dont les éléments visés par la question). */
  model: ModelSummaryEntry[];
  /** Éléments visés par la question (sous-ensemble du résumé). */
  targets: ModelSummaryEntry[];
  /** Morceau de la source `answer`. */
  chunk: ChunkInput;
}

const questionMessage = (q: AnswerIntegrateInput['question']): string =>
  `<question concept="${q.concept}">\n${q.text}\n</question>`;

/** `answer.integrate` (spécification 4.4) : candidats extraits de la réponse à une question. */
export const answerIntegratePipeline: PipelineDef<AnswerIntegrateInput, ExtractionCandidates> = {
  name: 'answer.integrate',
  version: '1',
  schemaName: 'ExtractionCandidates',
  outputSchema: extractionCandidatesSchema,
  buildRequest: (input) => ({
    system: loadPrompt('answer.integrate'),
    context: [
      summaryContext(input.model),
      input.targets.length === 0
        ? ''
        : `Éléments visés par la question : ${input.targets.map((e) => `${e.code} ${e.label}`).join(' ; ')}`,
    ]
      .filter((p) => p !== '')
      .join('\n'),
    messages: [
      {
        role: 'user',
        content: `${questionMessage(input.question)}\n${chunkMessage(input.chunk)}`,
      },
    ],
    maxOutputTokens: 16_000,
    effort: 'medium',
  }),
  // Même contrôle interne que l'extraction d'un morceau (la rétrogradation n'est pas une erreur).
  semanticCheck: (output, input, ctx) =>
    extractionChunkPipeline.semanticCheck?.(
      output,
      { chunk: input.chunk, model: input.model },
      ctx,
    ) ?? [],
};

// ------------------------------------------------------------------ hypotheses

export interface HypothesesInput {
  model: ModelSummaryEntry[];
  gaps: { concept: Concept; check: string; message: string }[];
  /** Hypothèses déjà rejetées : à ne pas reproposer, même autrement formulées. */
  rejected: { kind: string; label: string }[];
}

/** Une hypothèse proposée : sans citation, avec une justification obligatoire (PO-25). */
export const hypothesisProposalSchema = extractionCandidateSchema
  .omit({ chunkId: true, quote: true, rationale: true })
  .extend({ rationale: text });
export type HypothesisProposal = z.infer<typeof hypothesisProposalSchema>;

export const hypothesesOutputSchema = z.object({
  proposals: z.array(hypothesisProposalSchema).max(10),
});
export type HypothesesOutput = z.infer<typeof hypothesesOutputSchema>;

/** Identité d'une hypothèse pour détecter une répétition : nature et libellé normalisé. */
export const hypothesisKey = (kind: string, label: string): string => `${kind}|${norm(label)}`;

/** `hypotheses` (spécification 4.4) : éléments plausibles, origine `ai_knowledge`, jamais confirmés. */
export const hypothesesPipeline: PipelineDef<HypothesesInput, HypothesesOutput> = {
  name: 'hypotheses',
  version: '1',
  schemaName: 'Hypotheses',
  outputSchema: hypothesesOutputSchema,
  buildRequest: (input) => ({
    system: loadPrompt('hypotheses'),
    context: summaryContext(input.model),
    messages: [{ role: 'user', content: donnees({ gaps: input.gaps, rejected: input.rejected }) }],
    maxOutputTokens: 8_000,
    effort: 'medium',
  }),
  semanticCheck: (output, input) => {
    const issues: { path: string; message: string }[] = [];
    const rejected = new Set(input.rejected.map((r) => hypothesisKey(r.kind, r.label)));
    const refs = new Set<string>();
    output.proposals.forEach((p, i) => {
      const at = `proposals.${i}`;
      if (rejected.has(hypothesisKey(p.kind, p.label))) {
        issues.push({
          path: `${at}.label`,
          message: `« ${p.label} » a déjà été rejetée : ne pas la reproposer.`,
        });
      }
      if (refs.has(p.ref)) issues.push({ path: `${at}.ref`, message: `Référence en double.` });
      refs.add(p.ref);
      const required: Record<CandidateKind, unknown> = {
        business_trait: p.trait,
        actor: p.actor,
        activity: p.activity,
        tool: p.tool,
        glossary_term: p.term,
      };
      if (required[p.kind] === undefined) {
        issues.push({
          path: `${at}.${p.kind}`,
          message: 'Le détail propre à la nature est requis.',
        });
      }
      if (p.kind === 'activity' && p.activity !== undefined && p.activity.level !== 'macro') {
        if (p.activity.parent === undefined) {
          issues.push({
            path: `${at}.activity.parent`,
            message: 'Un processus ou une tâche désigne son parent.',
          });
        }
      }
    });
    return issues;
  },
};

// ------------------------------------------------------------------ deliverable.summary

export interface SummaryInput {
  /** Caractéristiques confirmées du métier (facette, libellé, texte). */
  traits: { facet: string; label: string; text: string }[];
}

export const summaryOutputSchema = z.object({ text, rationale: text });
export type SummaryOutput = z.infer<typeof summaryOutputSchema>;

/** `deliverable.summary` (spécification 4.4) : synthèse de la fiche métier, hypothèse à confirmer. */
export const summaryPipeline: PipelineDef<SummaryInput, SummaryOutput> = {
  name: 'deliverable.summary',
  version: '1',
  schemaName: 'DeliverableSummary',
  outputSchema: summaryOutputSchema,
  buildRequest: (input) => ({
    system: loadPrompt('deliverable.summary'),
    messages: [{ role: 'user', content: donnees({ traits: input.traits }) }],
    maxOutputTokens: 2_000,
    effort: 'low',
  }),
  semanticCheck: (output) =>
    output.text.trim().length < 20
      ? [{ path: 'text', message: 'La synthèse est trop courte pour résumer le métier.' }]
      : [],
};
