import { z } from 'zod';
import { globalRoleSchema, MISSION_ROLES } from '../auth/index.js';

/** Contrats d'administration : utilisateurs, clients, missions, configuration IA (WP-06). */

export const missionRoleSchema = z.enum(MISSION_ROLES);
export type MissionRoleValue = z.infer<typeof missionRoleSchema>;

export const MISSION_PHASES = ['analysis', 'mapping', 'transformation', 'generation'] as const;
export const missionPhaseSchema = z.enum(MISSION_PHASES);
export type MissionPhase = z.infer<typeof missionPhaseSchema>;

export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);

const uuid = z.string().uuid();

// ---------- Utilisateurs ----------

export const userSummarySchema = z.object({
  id: uuid,
  email: z.string(),
  displayName: z.string(),
  globalRole: globalRoleSchema,
  status: userStatusSchema,
  totpEnabled: z.boolean(),
  lastLoginAt: z.string().nullable(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const updateUserRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    globalRole: globalRoleSchema,
    status: z.enum(['active', 'disabled']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification.' });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

// ---------- Clients ----------

export const clientSchema = z.object({
  id: uuid,
  name: z.string(),
  defaultRetentionMonths: z.number().int(),
  createdAt: z.string(),
});
export type ClientDto = z.infer<typeof clientSchema>;

export const createClientRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  defaultRetentionMonths: z.number().int().min(1).max(240).optional(),
});
export type CreateClientRequest = z.infer<typeof createClientRequestSchema>;

export const updateClientRequestSchema = createClientRequestSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification.' });
export type UpdateClientRequest = z.infer<typeof updateClientRequestSchema>;

// ---------- Missions ----------

export const createMissionRequestSchema = z.object({
  clientId: uuid,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
});
export type CreateMissionRequest = z.infer<typeof createMissionRequestSchema>;

export const updateMissionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000),
    phase: missionPhaseSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification.' });
export type UpdateMissionRequest = z.infer<typeof updateMissionRequestSchema>;

export const assignMemberRequestSchema = z.object({
  userId: uuid,
  missionRole: missionRoleSchema,
});
export type AssignMemberRequest = z.infer<typeof assignMemberRequestSchema>;

/** Avancement affiché dans la liste de suivi (absent pour le validateur). */
export const missionProgressSchema = z.object({
  phase: missionPhaseSchema,
  /** Score global de complétude (0 à 1) ; `null` tant qu'aucune version du modèle n'existe. */
  completeness: z.number().min(0).max(1).nullable(),
  pendingSubmissions: z.number().int().min(0),
});
export type MissionProgress = z.infer<typeof missionProgressSchema>;

export const missionSummarySchema = z.object({
  id: uuid,
  name: z.string(),
  description: z.string(),
  clientId: uuid,
  clientName: z.string(),
  phase: missionPhaseSchema,
  headVersion: z.number().int(),
  /** Rôle du demandeur dans la mission ; `null` s'il la voit sans en être membre (administrateur, responsable). */
  myRole: missionRoleSchema.nullable(),
  createdAt: z.string(),
  progress: missionProgressSchema.nullable(),
});
export type MissionSummary = z.infer<typeof missionSummarySchema>;

export const memberSchema = z.object({
  userId: uuid,
  displayName: z.string(),
  email: z.string(),
  missionRole: missionRoleSchema,
});
export type MemberDto = z.infer<typeof memberSchema>;

// ---------- Configuration IA par client ----------

export const AI_PROVIDER_IDS = ['fake', 'anthropic'] as const;
export const aiProviderIdSchema = z.enum(AI_PROVIDER_IDS);

export const aiCapabilitiesSchema = z.object({
  text: z.boolean(),
  documents: z.boolean(),
  audio: z.boolean(),
});
export type AiCapabilitiesDto = z.infer<typeof aiCapabilitiesSchema>;

/** Capacités exigées par l'incrément 1 (spécification 4.1) : leur absence déclenche un avertissement. */
export const REQUIRED_AI_CAPABILITIES = ['text', 'documents'] as const;

/** Plafond mensuel par défaut (PO-12), en euros. */
export const DEFAULT_MONTHLY_BUDGET_EUR = 150;

/** Clé réservée de `models` : modèle par défaut de tous les pipelines (le plus léger, PO-12). */
export const DEFAULT_MODEL_KEY = 'default';

export const upsertAiConfigRequestSchema = z.object({
  provider: aiProviderIdSchema,
  /** Modèle par pipeline (`default` pour tous) : identifiants fournis par l'administrateur. */
  models: z
    .record(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), z.string().trim().min(1).max(200))
    .optional(),
  /** Absente : la clé enregistrée est conservée. Chaîne vide : elle est supprimée. */
  apiKey: z.string().max(512).optional(),
  capabilities: aiCapabilitiesSchema.optional(),
  monthlyBudgetEur: z.number().min(0).max(1_000_000).optional(),
  active: z.boolean().optional(),
  /** L'administrateur a lu la politique de données affichée et l'accepte. */
  acceptDataPolicy: z.boolean().optional(),
});
export type UpsertAiConfigRequest = z.infer<typeof upsertAiConfigRequestSchema>;

export const capabilityWarningSchema = z.object({
  code: z.literal('CAPABILITY_MISSING'),
  capability: z.enum(REQUIRED_AI_CAPABILITIES),
});
export type CapabilityWarning = z.infer<typeof capabilityWarningSchema>;

export const aiConfigSchema = z.object({
  id: uuid,
  clientId: uuid,
  provider: aiProviderIdSchema,
  models: z.record(z.string(), z.string()),
  apiKey: z.object({ configured: z.boolean(), masked: z.string().nullable() }),
  capabilities: aiCapabilitiesSchema,
  dataPolicyText: z.string().nullable(),
  policyAcceptedBy: uuid.nullable(),
  policyAcceptedAt: z.string().nullable(),
  monthlyBudgetEur: z.number().nullable(),
  active: z.boolean(),
  warnings: z.array(capabilityWarningSchema),
});
export type AiConfigDto = z.infer<typeof aiConfigSchema>;

export const dataPolicySchema = z.object({
  provider: aiProviderIdSchema,
  text: z.string().nullable(),
});
export type DataPolicyDto = z.infer<typeof dataPolicySchema>;

export const uuidSchema = uuid;

/** Capacités exigées par l'incrément 1 que le fournisseur ne déclare pas (CDC 6.5). */
export function capabilityWarnings(capabilities: AiCapabilitiesDto): CapabilityWarning[] {
  return REQUIRED_AI_CAPABILITIES.filter((c) => !capabilities[c]).map((capability) => ({
    code: 'CAPABILITY_MISSING' as const,
    capability,
  }));
}

export const createMissionResponseSchema = z.object({
  mission: missionSummarySchema,
  /** Avertissements de capacité du fournisseur IA du client (la mission est créée malgré tout). */
  warnings: z.array(capabilityWarningSchema),
});
export type CreateMissionResponse = z.infer<typeof createMissionResponseSchema>;
