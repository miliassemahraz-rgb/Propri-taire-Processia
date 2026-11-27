import { z } from 'zod';
import type { SourceDto } from '../sources/index.js';

/** Contrats du questionnement guidé et des décisions sur les éléments (WP-14). */

export const QUESTION_STATUSES = ['open', 'answered', 'skipped'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export interface QuestionDto {
  id: string;
  concept: string;
  text: string;
  rationale: string | null;
  /** 0 à 100 : à quel point la réponse débloque la suite. */
  blockingScore: number | null;
  targetElementIds: string[];
  status: QuestionStatus;
  answerSourceId: string | null;
  answeredBy: string | null;
  /** Rang parmi les questions ouvertes (1 : la plus bloquante). */
  rank: number | null;
  createdAt: string;
}

/** Réponse à une question : du texte libre, figé en source `answer`. */
export const answerQuestionSchema = z.object({ text: z.string().trim().min(1).max(20_000) });
export type AnswerQuestionRequest = z.infer<typeof answerQuestionSchema>;

export interface AnswerQuestionResult {
  /** Exécution `answer` (intégration de la réponse), suivie par `run.progress`. */
  runId: string;
  source: SourceDto;
  question: QuestionDto;
}

/** Lancement d'un pipeline guidé (`questions`, `hypotheses`, `deliverable.summary`). */
export interface StartGuidedResult {
  runId: string;
}

export interface StopQuestionsResult {
  skipped: number;
}

export const GUIDED_RUN_KINDS = [
  'questions',
  'hypotheses',
  'summary',
  'answer',
  /** Lot d'enchaînements des processus (WP-17) : suivi comme les autres exécutions guidées. */
  'process_flow',
] as const;
export type GuidedRunKind = (typeof GUIDED_RUN_KINDS)[number];

/** Attributs textuels d'un élément d'analyse que le consultant peut corriger par formulaire [PO-5]. */
export const correctionSchema = z
  .object({
    label: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(5_000).optional(),
    /** Texte d'un trait du métier. */
    text: z.string().trim().min(1).max(5_000).optional(),
    /** Définition d'un terme du glossaire. */
    definition: z.string().trim().min(1).max(5_000).optional(),
    /** Responsabilités d'un acteur. */
    responsibilities: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  })
  .strict();
export type Correction = z.infer<typeof correctionSchema>;

/** Décision du consultant sur un élément `extracted` ou `hypothesis` (CDC 3.1, spécification 2.1). */
export const decisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('accept') }),
  z.object({ decision: z.literal('correct'), correction: correctionSchema }),
  z.object({ decision: z.literal('reject'), reason: z.string().trim().max(1_000).optional() }),
]);
export type DecisionRequest = z.infer<typeof decisionSchema>;

export interface DecisionResult {
  /** Version du modèle produite par la décision. */
  version: number;
  /** `confirmed`, ou `rejected` : l'hypothèse est retirée du modèle et archivée. */
  outcome: 'confirmed' | 'rejected';
}

/** Message sans état `question.updated` : la liste des questions de la mission a changé. */
export interface QuestionUpdatedMessage {
  type: 'question.updated';
  missionId: string;
}
