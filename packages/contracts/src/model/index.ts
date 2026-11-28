import { ChangeSetSchema, type BusinessModel, type ModelDiff } from '@processia/model';
import { z } from 'zod';

/** Contrats de la persistance versionnée du modèle (WP-08). */

export const commitChangeSetRequestSchema = z.object({ changeSet: ChangeSetSchema });
export type CommitChangeSetRequest = z.infer<typeof commitChangeSetRequestSchema>;

export const rollbackRequestSchema = z.object({ toVersion: z.number().int().positive() });
export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;

/** `?version=` : absent = version de tête. */
export const modelQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
});

export const diffQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().nonnegative(),
});

/** Avertissement de cohérence renvoyé avec une version (jamais bloquant). */
export interface CoherenceWarningDto {
  code: string;
  severity: 'warning';
  elementId: string;
  message: string;
  relatedIds?: string[];
}

export interface CommitResult {
  version: number;
  diff: ModelDiff;
  warnings: CoherenceWarningDto[];
  /** Version de départ du ChangeSet quand il a été rebasé sur la tête (« adapté à la version N »). */
  rebasedFrom: number | null;
  /** Éléments validés repassés à `confirmed` par cette version (signalements créés). */
  noticedElementIds: string[];
}

export interface ModelAtVersion {
  version: number;
  model: BusinessModel;
}

export interface VersionSummary {
  version: number;
  parentVersion: number | null;
  cause: string;
  summary: string | null;
  authorId: string | null;
  createdAt: string;
}

export type ElementChange = 'added' | 'updated' | 'removed' | 'status';

export interface ElementHistoryEntry extends VersionSummary {
  change: ElementChange;
}

export const PROPOSAL_STATUSES = ['pending', 'applied', 'discarded', 'stale'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface ProposalDto {
  id: string;
  baseVersion: number;
  instruction: string;
  changeSet: unknown;
  explanation: string | null;
  diff: ModelDiff | null;
  warnings: CoherenceWarningDto[];
  status: ProposalStatus;
  createdBy: string | null;
  appliedVersion: number | null;
  createdAt: string;
  /** Version de tête sur laquelle l'aperçu a été recalculé (« adapté à la version N »), sinon nul. */
  adaptedToVersion: number | null;
}

/** Message sans état : une proposition de modification a changé d'état (nouvelle, appliquée, abandonnée, périmée). */
export interface ProposalUpdatedMessage {
  type: 'proposal.updated';
  missionId: string;
  proposalId: string;
  status: ProposalStatus;
}
