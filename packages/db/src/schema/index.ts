import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, citext, createdAt, pk, tsvector, tstz, type Json } from './types.js';

// Valeurs des énumérations (spécification 3.2 et 2.7). Les contraintes CHECK correspondantes sont
// dans la migration SQL « contraintes » ; ces constantes servent aux types applicatifs.
export const GLOBAL_ROLES = ['admin', 'mission_manager', 'consultant', 'client_validator'] as const;
export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export const MISSION_ROLES = ['manager', 'consultant', 'validator'] as const;
export const MISSION_PHASES = ['analysis', 'mapping', 'transformation', 'generation'] as const;
export const AI_PROVIDERS = ['fake', 'anthropic'] as const;
export const VERSION_CHANGES = ['added', 'updated', 'removed', 'status'] as const;
export const PROPOSAL_STATUSES = ['pending', 'applied', 'discarded', 'stale'] as const;
export const DIALOGUE_THREADS = ['analysis', 'mapping', 'transformation'] as const;
export const DIALOGUE_ROLES = ['user', 'assistant', 'system'] as const;
export const SOURCE_KINDS = ['free_text', 'answer', 'document'] as const;
export const QUESTION_STATUSES = ['open', 'answered', 'skipped'] as const;
export const SUBMISSION_KINDS = ['analysis_dossier', 'as_is', 'to_be'] as const;
export const SUBMISSION_STATUSES = [
  'submitted',
  'validated',
  'superseded',
  'withdrawn',
  'closed',
] as const;
export const DECISION_VALUES = ['accepted', 'rejected'] as const;
export const DECISION_CAUSES = ['direct', 'cascade'] as const;
export const COMMENT_TARGETS = ['element', 'submission', 'optimisation', 'deliverable'] as const;
export const ARTIFACT_KINDS = ['docx', 'pdf', 'xlsx', 'bpmn', 'zip', 'svg'] as const;

// ===================== Tables non cloisonnées =====================

export const users = pgTable('users', {
  id: pk(),
  email: citext('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash'),
  globalRole: text('global_role').notNull(),
  status: text('status').notNull().default('invited'),
  totpSecretEnc: text('totp_secret_enc'),
  totpEnabledAt: tstz('totp_enabled_at'),
  lastLoginAt: tstz('last_login_at'),
  /** Échecs de connexion consécutifs (mot de passe ou second facteur) : verrouillage à 6 (WP-05). */
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: tstz('locked_until'),
  /** Dernier pas de temps TOTP accepté : un code ne sert qu'une fois (anti-rejeu, WP-05). */
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  createdAt: createdAt(),
});

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: tstz('used_at'),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('auth_identities_provider_subject_uq').on(t.provider, t.subject)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    idHash: text('id_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mfaVerifiedAt: tstz('mfa_verified_at'),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const clients = pgTable('clients', {
  id: pk(),
  name: text('name').notNull(),
  defaultRetentionMonths: integer('default_retention_months').notNull().default(24),
  createdAt: createdAt(),
});

export const missions = pgTable(
  'missions',
  {
    id: pk(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    phase: text('phase').notNull().default('analysis'),
    headVersion: integer('head_version').notNull().default(0),
    retentionUntil: tstz('retention_until'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    archivedAt: tstz('archived_at'),
  },
  (t) => [index('missions_client_idx').on(t.clientId)],
);

export const invitations = pgTable('invitations', {
  id: pk(),
  tokenHash: text('token_hash').notNull().unique(),
  email: citext('email').notNull(),
  globalRole: text('global_role').notNull(),
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'cascade' }),
  missionRole: text('mission_role'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  expiresAt: tstz('expires_at').notNull(),
  acceptedAt: tstz('accepted_at'),
});

export const aiProviderConfigs = pgTable('ai_provider_configs', {
  id: pk(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('fake'),
  /** Modèle par pipeline : `{ [pipeline]: modelId }` (aucun identifiant en dur dans le code). */
  models: jsonb('models').$type<Record<string, string>>().notNull().default({}),
  apiKeyEnc: text('api_key_enc'),
  /** `{ text, documents, audio }` */
  capabilities: jsonb('capabilities')
    .$type<{ text: boolean; documents: boolean; audio: boolean }>()
    .notNull()
    .default({ text: true, documents: false, audio: false }),
  dataPolicyText: text('data_policy_text'),
  policyAcceptedBy: uuid('policy_accepted_by').references(() => users.id),
  policyAcceptedAt: tstz('policy_accepted_at'),
  monthlyBudgetEur: numeric('monthly_budget_eur', { precision: 10, scale: 2 }),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const missionMembers = pgTable(
  'mission_members',
  {
    id: pk(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    missionRole: text('mission_role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mission_members_mission_user_uq').on(t.missionId, t.userId),
    // CDC 2.3 : un seul validateur par mission.
    uniqueIndex('mission_members_one_validator_uq')
      .on(t.missionId)
      .where(sql`${t.missionRole} = 'validator'`),
    index('mission_members_user_idx').on(t.userId),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Json>().notNull().default({}),
    createdAt: createdAt(),
    readAt: tstz('read_at'),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt)],
);

/** Ajout seulement : le rôle applicatif n'a que INSERT et SELECT. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    actorId: uuid('actor_id'),
    missionId: uuid('mission_id'),
    action: text('action').notNull(),
    target: text('target'),
    payload: jsonb('payload').$type<Json>().notNull().default({}),
    ip: text('ip'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_mission_idx').on(t.missionId, t.at)],
);

// ===================== Tables cloisonnées par RLS (colonne mission_id) =====================

const missionId = () =>
  uuid('mission_id')
    .notNull()
    .references(() => missions.id, { onDelete: 'cascade' });

export const aiCalls = pgTable(
  'ai_calls',
  {
    id: pk(),
    // Nullable : appel hors mission (ex. test de configuration d'un client).
    missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    pipeline: text('pipeline').notNull(),
    pipelineVersion: text('pipeline_version').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputHash: text('input_hash').notNull(),
    request: jsonb('request').$type<Json>(),
    response: jsonb('response').$type<Json>(),
    status: text('status').notNull(),
    error: text('error'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costEstimateEur: numeric('cost_estimate_eur', { precision: 12, scale: 6 }),
    durationMs: integer('duration_ms'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('ai_calls_mission_idx').on(t.missionId, t.createdAt)],
);

export const modelVersions = pgTable(
  'model_versions',
  {
    missionId: missionId(),
    version: integer('version').notNull(),
    parentVersion: integer('parent_version'),
    /** Instantané complet du modèle. TODO(WP-02) : type `ModelSnapshot` de `@processia/model`. */
    snapshot: jsonb('snapshot').$type<Json>().notNull(),
    /** TODO(WP-02) : type `ChangeSet`. */
    changeSet: jsonb('change_set').$type<Json>(),
    /** TODO(WP-02) : type du diff entre deux versions. */
    diff: jsonb('diff').$type<Json>(),
    cause: text('cause').notNull(),
    summary: text('summary'),
    authorId: uuid('author_id').references(() => users.id),
    aiCallId: uuid('ai_call_id').references(() => aiCalls.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.missionId, t.version] })],
);

export const modelVersionElements = pgTable(
  'model_version_elements',
  {
    missionId: missionId(),
    version: integer('version').notNull(),
    elementId: text('element_id').notNull(),
    change: text('change').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.missionId, t.version, t.elementId] }),
    foreignKey({
      columns: [t.missionId, t.version],
      foreignColumns: [modelVersions.missionId, modelVersions.version],
    }).onDelete('cascade'),
    index('model_version_elements_element_idx').on(t.missionId, t.elementId, t.version),
  ],
);

export const changeProposals = pgTable(
  'change_proposals',
  {
    id: pk(),
    missionId: missionId(),
    baseVersion: integer('base_version').notNull(),
    instruction: text('instruction').notNull(),
    changeSet: jsonb('change_set').$type<Json>().notNull(),
    explanation: text('explanation'),
    diff: jsonb('diff').$type<Json>(),
    warnings: jsonb('warnings').$type<Json>(),
    status: text('status').notNull().default('pending'),
    createdBy: uuid('created_by').references(() => users.id),
    aiCallId: uuid('ai_call_id').references(() => aiCalls.id),
    appliedVersion: integer('applied_version'),
    createdAt: createdAt(),
  },
  (t) => [index('change_proposals_mission_idx').on(t.missionId, t.status)],
);

export const dialogueMessages = pgTable(
  'dialogue_messages',
  {
    id: pk(),
    missionId: missionId(),
    thread: text('thread').notNull(),
    authorId: uuid('author_id').references(() => users.id),
    role: text('role').notNull(),
    content: text('content').notNull(),
    proposalId: uuid('proposal_id').references(() => changeProposals.id),
    createdAt: createdAt(),
  },
  (t) => [index('dialogue_messages_thread_idx').on(t.missionId, t.thread, t.createdAt)],
);

export const sources = pgTable(
  'sources',
  {
    id: pk(),
    missionId: missionId(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    revision: integer('revision').notNull().default(1),
    storageKey: text('storage_key'),
    mime: text('mime'),
    sha256: text('sha256'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    textStatus: text('text_status').notNull().default('pending'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('sources_mission_idx').on(t.missionId)],
);

export const sourceChunks = pgTable(
  'source_chunks',
  {
    id: pk(),
    missionId: missionId(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    locator: jsonb('locator').$type<Json>(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('french', text)`),
  },
  (t) => [
    uniqueIndex('source_chunks_source_ordinal_uq').on(t.sourceId, t.ordinal),
    index('source_chunks_tsv_idx').using('gin', t.tsv),
  ],
);

export const analysisRuns = pgTable(
  'analysis_runs',
  {
    id: pk(),
    missionId: missionId(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('queued'),
    progress: integer('progress').notNull().default(0),
    jobId: text('job_id'),
    error: text('error'),
    resultVersion: integer('result_version'),
    startedBy: uuid('started_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('analysis_runs_mission_idx').on(t.missionId, t.createdAt)],
);

export const questions = pgTable(
  'questions',
  {
    id: pk(),
    missionId: missionId(),
    concept: text('concept').notNull(),
    text: text('text').notNull(),
    rationale: text('rationale'),
    blockingScore: numeric('blocking_score', { precision: 6, scale: 3 }),
    targetElementIds: jsonb('target_element_ids').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('open'),
    answerSourceId: uuid('answer_source_id').references(() => sources.id),
    answeredBy: uuid('answered_by').references(() => users.id),
    rank: integer('rank'),
    createdAt: createdAt(),
  },
  (t) => [index('questions_mission_idx').on(t.missionId, t.status, t.rank)],
);

export const validationSubmissions = pgTable(
  'validation_submissions',
  {
    id: pk(),
    missionId: missionId(),
    kind: text('kind').notNull(),
    round: integer('round').notNull().default(1),
    modelVersion: integer('model_version').notNull(),
    artifactIds: jsonb('artifact_ids').$type<string[]>().notNull().default([]),
    excludedHypothesisIds: jsonb('excluded_hypothesis_ids').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('submitted'),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.id),
    submittedAt: tstz('submitted_at').notNull().defaultNow(),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: tstz('decided_at'),
    comment: text('comment'),
  },
  (t) => [uniqueIndex('validation_submissions_round_uq').on(t.missionId, t.kind, t.round)],
);

export const optimisationDecisions = pgTable(
  'optimisation_decisions',
  {
    id: pk(),
    missionId: missionId(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => validationSubmissions.id, { onDelete: 'cascade' }),
    optimisationId: text('optimisation_id').notNull(),
    value: text('value').notNull(),
    cause: text('cause').notNull().default('direct'),
    cascadeFrom: text('cascade_from'),
    comment: text('comment'),
    by: uuid('by')
      .notNull()
      .references(() => users.id),
    at: tstz('at').notNull().defaultNow(),
    supersededAt: tstz('superseded_at'),
  },
  (t) => [index('optimisation_decisions_submission_idx').on(t.submissionId, t.optimisationId)],
);

export const postValidationNotices = pgTable(
  'post_validation_notices',
  {
    id: pk(),
    missionId: missionId(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => validationSubmissions.id, { onDelete: 'cascade' }),
    elementId: text('element_id').notNull(),
    version: integer('version').notNull(),
    summary: text('summary').notNull(),
    createdAt: createdAt(),
    seenAt: tstz('seen_at'),
  },
  (t) => [index('post_validation_notices_mission_idx').on(t.missionId, t.seenAt)],
);

export const comments = pgTable(
  'comments',
  {
    id: pk(),
    missionId: missionId(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    modelVersion: integer('model_version'),
    parentId: uuid('parent_id'),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
    resolvedAt: tstz('resolved_at'),
  },
  (t) => [
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id] }).onDelete('cascade'),
    index('comments_target_idx').on(t.missionId, t.targetKind, t.targetId),
  ],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: pk(),
    missionId: missionId(),
    kind: text('kind').notNull(),
    purpose: text('purpose').notNull(),
    modelVersion: integer('model_version'),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('artifacts_mission_idx').on(t.missionId, t.createdAt)],
);

export const yjsDocuments = pgTable('yjs_documents', {
  /** Ex. `mission:<id>:workspace`. */
  name: text('name').primaryKey(),
  missionId: missionId(),
  state: bytea('state').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

/**
 * Tables cloisonnées par RLS (politique sur `mission_id`). Liste partagée par la migration RLS
 * (vérifiée par test) et par le test paramétré d'isolation.
 */
export const MISSION_SCOPED_TABLES = [
  'model_versions',
  'model_version_elements',
  'change_proposals',
  'dialogue_messages',
  'sources',
  'source_chunks',
  'analysis_runs',
  'questions',
  'validation_submissions',
  'optimisation_decisions',
  'post_validation_notices',
  'comments',
  'artifacts',
  'ai_calls',
  'yjs_documents',
] as const;

export type MissionScopedTable = (typeof MISSION_SCOPED_TABLES)[number];
