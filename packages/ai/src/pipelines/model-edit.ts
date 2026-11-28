import { z } from 'zod';
import { loadPrompt } from '../prompts.js';
import type { PipelineDef } from '../runner.js';
import { DONNEES_CLOSE, DONNEES_OPEN } from './extraction.js';

const text = z.string().min(1);

// ------------------------------------------------------------------ entrée

export interface EditFocus {
  /** Diagramme affiché : `L0`, `L1:<id>`, `L2:<id>` ou `L3:<id>`. */
  diagram: string;
  /** Code et libellé de l'ancre du diagramme (absents au niveau 0). */
  code?: string;
  label?: string;
  /** Élément sélectionné dans la visionneuse, pour « cette tâche ». */
  selected?: { code: string; label: string };
}

export interface EditScopeNode {
  code: string;
  kind: 'task' | 'step' | 'event' | 'gateway';
  label: string;
  /** Libellé de l'acteur responsable. */
  actor?: string;
  /** Code du conteneur : le processus (niveau 2) ou la tâche (niveau 3). */
  container: string;
  position?: string;
  gatewayType?: string;
}

export interface EditScope {
  code: string;
  label: string;
  nodes: EditScopeNode[];
  flows: { code: string; from: string; to: string; condition?: string }[];
  rules: { code: string; label: string; type: string }[];
  indicators: {
    code: string;
    label: string;
    target: string;
    measure: string;
    value: string;
    unit: string;
  }[];
}

export interface EditInput {
  instruction: string;
  /** Derniers échanges du fil (consigne précédente, question de clarification). */
  history: { role: 'user' | 'assistant'; content: string }[];
  focus: EditFocus;
  actors: { code: string; label: string; category: string }[];
  /** Processus du périmètre, avec leurs tâches : le contexte réduit (spécification 7, R-2). */
  processes: {
    code: string;
    label: string;
    macro: string;
    tasks: { code: string; label: string; actor?: string }[];
  }[];
  /** Détail du processus visé (niveau 2 ou 3) : nœuds, flux, règles, indicateurs. */
  scope?: EditScope;
}

// ------------------------------------------------------------------ sortie

/**
 * Actions d'édition de haut niveau : l'IA ne décrit jamais d'opérations sur le modèle, elle dit ce
 * que le consultant demande ; le code déterministe (`buildEditChangeSet`) les traduit en
 * opérations, recâble les enchaînements et vérifie le résultat.
 */
export const editActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('insert_task'),
    /** Libellé de la tâche (niveau 2) ou de l'étape (niveau 3) créée. */
    label: text,
    description: text.optional(),
    /** Code de l'élément (tâche, étape, événement, passerelle) après ou avant lequel on insère. */
    anchor: text,
    placement: z.enum(['after', 'before']),
    /** Libellé exact d'un acteur connu ; absent : la tâche n'a pas de responsable. */
    actor: text.optional(),
    execution: z.enum(['manual', 'user', 'automatic', 'ai_agent']).optional(),
  }),
  z.object({
    action: z.literal('reassign'),
    /** Code de la tâche, de l'étape, de l'événement ou de la passerelle. */
    target: text,
    /** Libellé exact d'un acteur connu. */
    actor: text,
  }),
  z.object({
    action: z.literal('rename'),
    target: text,
    label: text.optional(),
    description: text.optional(),
  }),
  z.object({
    action: z.literal('remove'),
    target: text,
  }),
  z.object({
    action: z.literal('add_exception'),
    /** Code de la tâche ou de l'étape concernée. */
    target: text,
    label: text,
    text,
    when: text.optional(),
    then: text.optional(),
    otherwise: text.optional(),
    circuit: z.enum(['reminder', 'escalation', 'deadline', 'alert', 'other']),
    circuitDescription: text,
  }),
  z.object({
    action: z.literal('set_indicator'),
    /** Code d'un indicateur existant, ou d'une tâche (avec `measure`) pour en créer un. */
    target: text,
    measure: z
      .enum(['volume', 'lead_time', 'duration', 'frequency', 'workload', 'cost', 'error_rate'])
      .optional(),
    label: text.optional(),
    exact: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    unit: text.optional(),
  }),
]);
export type EditAction = z.infer<typeof editActionSchema>;

export const editPlanSchema = z.object({
  /**
   * Question de clarification (consigne ambiguë ou cible introuvable) : quand elle est posée,
   * `actions` est vide et rien n'est proposé.
   */
  clarification: text.optional(),
  /** Ce que la modification fait, en une ou deux phrases pour le consultant. */
  explanation: text,
  actions: z.array(editActionSchema).max(12),
  /** Codes des éléments touchés. */
  touched: z.array(text).max(40),
});
export type EditPlan = z.infer<typeof editPlanSchema>;

const donnees = (value: unknown): string =>
  `${DONNEES_OPEN}\n${JSON.stringify(value)}\n${DONNEES_CLOSE}`;

/** `model.edit` (spécification 4.4) : une consigne en langage naturel devient un plan d'édition. */
export const modelEditPipeline: PipelineDef<EditInput, EditPlan> = {
  name: 'model.edit',
  version: '1',
  schemaName: 'EditPlan',
  outputSchema: editPlanSchema,
  buildRequest: (input) => ({
    system: loadPrompt('model.edit'),
    context:
      input.scope === undefined
        ? `Cartographie : ${input.focus.diagram}.`
        : `Processus ${input.scope.code} « ${input.scope.label} » (${input.focus.diagram}).`,
    messages: [{ role: 'user', content: donnees(input) }],
    maxOutputTokens: 4_000,
    effort: 'low',
  }),
};
