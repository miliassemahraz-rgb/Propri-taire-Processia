import { z } from 'zod';
import type { ProposalDto } from '../model/index.js';
import { diagramIdParamSchema } from '../cartography/index.js';

/** Contrats de la modification par dialogue (WP-20, spécification 4.4 `model.edit`). */

export const DIALOGUE_THREADS = ['analysis', 'mapping', 'transformation'] as const;
export type DialogueThread = (typeof DIALOGUE_THREADS)[number];

export const DIALOGUE_ROLES = ['user', 'assistant', 'system'] as const;
export type DialogueRole = (typeof DIALOGUE_ROLES)[number];

/** Longueur maximale d'une consigne : une demande, pas un document. */
export const MAX_INSTRUCTION_LENGTH = 1_500;

export const sendDialogueMessageSchema = z.object({
  text: z.string().trim().min(1).max(MAX_INSTRUCTION_LENGTH),
  /** Diagramme affiché et élément sélectionné : ils réduisent le contexte envoyé à l'IA. */
  focus: z
    .object({
      diagram: diagramIdParamSchema,
      selectedId: z.string().uuid().optional(),
    })
    .optional(),
});
export type SendDialogueMessageRequest = z.infer<typeof sendDialogueMessageSchema>;

export interface DialogueMessageDto {
  id: string;
  role: DialogueRole;
  content: string;
  authorId: string | null;
  /** Proposition jointe au message de l'assistant. */
  proposalId: string | null;
  createdAt: string;
}

/** Fil du dialogue de la cartographie et propositions qu'il a produites (les plus récentes). */
export interface DialogueDto {
  messages: DialogueMessageDto[];
  proposals: ProposalDto[];
}

export interface SendDialogueResult {
  /** Le message du consultant, puis la réponse de l'assistant (proposition ou question). */
  messages: DialogueMessageDto[];
  /** Proposition créée ; nulle quand l'assistant pose une question ou ne peut pas traduire la consigne. */
  proposal: ProposalDto | null;
}

/** Nouvelle proposition issue d'une proposition périmée (« Régénérer »). */
export type RegenerateProposalResult = SendDialogueResult;
