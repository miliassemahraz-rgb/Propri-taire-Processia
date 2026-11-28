import {
  aiConfigSchema,
  aiStatusSchema,
  assignableUserSchema,
  clientSchema,
  collabTokenResponseSchema,
  createInvitationResponseSchema,
  createMissionResponseSchema,
  dataPolicySchema,
  memberSchema,
  meResponseSchema,
  mfaConfirmResponseSchema,
  mfaEnrollResponseSchema,
  loginResponseSchema,
  missionSummarySchema,
  sessionOpenedResponseSchema,
  recoveryResponseSchema,
  userSummarySchema,
  type AcceptInvitationRequest,
  type AnswerQuestionResult,
  type ChunkDto,
  type ChunkViewDto,
  type CommentDto,
  type CommentTargetKind,
  type CommitResult,
  type CreateCommentRequest,
  type CreateSubmissionRequest,
  type DecisionRequest,
  type DecisionResult,
  type DeliverablesPreviewDto,
  type ExportArtifactDto,
  type FlowDecisionRequest,
  type FlowDecisionResult,
  type BpmnDiagramDto,
  type FlowOverviewDto,
  type ExportFormat,
  type NoticeDto,
  type NotificationDto,
  type PresignedUrlDto,
  type StartExportResult,
  type StartFlowRequest,
  type StartFlowResult,
  type SubmissionDto,
  type SubmissionElementDto,
  type SubmissionKind,
  type SubmissionPreviewDto,
  type ValidateSubmissionResult,
  type QuestionDto,
  type RunDto,
  type SourceDto,
  type StartExtractionResult,
  type StartGuidedResult,
  type StopQuestionsResult,
  type UploadSourceResult,
  type VersionSummary,
  type AssignMemberRequest,
  type CreateClientRequest,
  type CreateInvitationRequest,
  type CreateMissionRequest,
  type UpdateUserRequest,
  type UpsertAiConfigRequest,
} from '@processia/contracts';
import type { BusinessModel, ModelDiff } from '@processia/model';
import { z } from 'zod';
import { apiRequest } from './api';

/** Réponse décrite par un type des contrats (sans schéma zod) : la forme est celle de l'API. */
const typed = <T>() => z.custom<T>(() => true);

/** Client API typé : un appel par route de l'API, validé par les schémas de `@processia/contracts`. */
export const endpoints = {
  // Authentification (WP-05)
  login: (body: { email: string; password: string }) =>
    apiRequest('/auth/login', { method: 'POST', body, schema: loginResponseSchema }),
  mfaVerify: (code: string) =>
    apiRequest('/auth/mfa/verify', {
      method: 'POST',
      body: { code },
      schema: sessionOpenedResponseSchema,
    }),
  mfaEnroll: () =>
    apiRequest('/auth/mfa/enroll', { method: 'POST', body: {}, schema: mfaEnrollResponseSchema }),
  mfaConfirm: (code: string) =>
    apiRequest('/auth/mfa/confirm', {
      method: 'POST',
      body: { code },
      schema: mfaConfirmResponseSchema,
    }),
  recovery: (code: string) =>
    apiRequest('/auth/recovery', {
      method: 'POST',
      body: { code },
      schema: recoveryResponseSchema,
    }),
  logout: () => apiRequest('/auth/logout', { method: 'POST', body: {} }),
  me: () => apiRequest('/me', { schema: meResponseSchema }),
  acceptInvitation: (token: string, body: AcceptInvitationRequest) =>
    apiRequest(`/invitations/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      body,
      schema: z.object({ email: z.string() }),
    }),
  createInvitation: (body: CreateInvitationRequest) =>
    apiRequest('/invitations', { method: 'POST', body, schema: createInvitationResponseSchema }),

  // Utilisateurs, clients (WP-06)
  listUsers: () => apiRequest('/users', { schema: z.array(userSummarySchema) }),
  updateUser: (id: string, body: UpdateUserRequest) =>
    apiRequest(`/users/${id}`, { method: 'PATCH', body, schema: userSummarySchema }),
  unlockUser: (id: string) =>
    apiRequest(`/users/${id}/unlock`, { method: 'POST', body: {}, schema: userSummarySchema }),
  listClients: () => apiRequest('/clients', { schema: z.array(clientSchema) }),
  createClient: (body: CreateClientRequest) =>
    apiRequest('/clients', { method: 'POST', body, schema: clientSchema }),
  getAiConfig: (clientId: string) =>
    apiRequest(`/clients/${clientId}/ai-config`, { schema: aiConfigSchema }),
  putAiConfig: (clientId: string, body: UpsertAiConfigRequest) =>
    apiRequest(`/clients/${clientId}/ai-config`, { method: 'PUT', body, schema: aiConfigSchema }),
  dataPolicy: (provider: 'fake' | 'anthropic') =>
    apiRequest(`/ai-providers/${provider}/data-policy`, { schema: dataPolicySchema }),

  // Missions (WP-06)
  listMissions: () => apiRequest('/missions', { schema: z.array(missionSummarySchema) }),
  createMission: (body: CreateMissionRequest) =>
    apiRequest('/missions', { method: 'POST', body, schema: createMissionResponseSchema }),
  getMission: (id: string) => apiRequest(`/missions/${id}`, { schema: missionSummarySchema }),
  listMembers: (id: string) =>
    apiRequest(`/missions/${id}/members`, { schema: z.array(memberSchema) }),
  assignableUsers: (id: string) =>
    apiRequest(`/missions/${id}/assignable-users`, { schema: z.array(assignableUserSchema) }),
  assignMember: (id: string, body: AssignMemberRequest) =>
    apiRequest(`/missions/${id}/members`, {
      method: 'PUT',
      body,
      schema: z.array(memberSchema),
    }),
  removeMember: (id: string, userId: string) =>
    apiRequest(`/missions/${id}/members/${userId}`, { method: 'DELETE' }),
  aiStatus: (id: string) => apiRequest(`/missions/${id}/ai-status`, { schema: aiStatusSchema }),

  // Coédition (WP-10) : jeton court pour le serveur Hocuspocus
  collabToken: (id: string) =>
    apiRequest(`/missions/${id}/collab-token`, {
      method: 'POST',
      body: {},
      schema: collabTokenResponseSchema,
    }),

  // Modèle (WP-08) : tête de version, pour la complétude du tableau de bord
  headModel: (id: string) =>
    apiRequest(`/missions/${id}/model`, {
      schema: z.object({ version: z.number().int(), model: z.unknown() }),
    }),

  // Analyse (WP-12, WP-13)
  startExtraction: (id: string, sourceId?: string) =>
    apiRequest(`/missions/${id}/analysis/extractions`, {
      method: 'POST',
      body: sourceId === undefined ? {} : { sourceId },
      schema: typed<StartExtractionResult>(),
    }),
  getRun: (id: string, runId: string) =>
    apiRequest(`/missions/${id}/runs/${runId}`, { schema: typed<RunDto>() }),
  listSources: (id: string) =>
    apiRequest(`/missions/${id}/sources`, { schema: typed<SourceDto[]>() }),
  uploadDocument: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiRequest(`/missions/${id}/sources/documents`, {
      method: 'POST',
      form,
      schema: typed<UploadSourceResult>(),
    });
  },
  sourceChunks: (id: string, sourceId: string) =>
    apiRequest(`/missions/${id}/sources/${sourceId}/chunks`, { schema: typed<ChunkDto[]>() }),
  chunkView: (
    id: string,
    sourceId: string,
    ordinal: number,
    highlight?: { charStart: number; charEnd: number },
  ) =>
    apiRequest(
      `/missions/${id}/sources/${sourceId}/chunks/${ordinal}${
        highlight === undefined
          ? ''
          : `?charStart=${highlight.charStart}&charEnd=${highlight.charEnd}`
      }`,
      { schema: typed<ChunkViewDto>() },
    ),

  // Historique des versions (WP-08, WP-13)
  listVersions: (id: string) =>
    apiRequest(`/missions/${id}/model/versions`, { schema: typed<VersionSummary[]>() }),
  modelDiff: (id: string, from: number, to: number) =>
    apiRequest(`/missions/${id}/model/diff?from=${from}&to=${to}`, { schema: typed<ModelDiff>() }),
  modelAt: (id: string, version: number) =>
    apiRequest(`/missions/${id}/model?version=${version}`, {
      schema: typed<{ version: number; model: BusinessModel }>(),
    }),
  // Questionnement guidé, hypothèses et décisions (WP-14)
  listQuestions: (id: string) =>
    apiRequest(`/missions/${id}/questions`, { schema: typed<QuestionDto[]>() }),
  generateQuestions: (id: string) =>
    apiRequest(`/missions/${id}/questions/generate`, {
      method: 'POST',
      body: {},
      schema: typed<StartGuidedResult>(),
    }),
  answerQuestion: (id: string, questionId: string, text: string) =>
    apiRequest(`/missions/${id}/questions/${questionId}/answer`, {
      method: 'POST',
      body: { text },
      schema: typed<AnswerQuestionResult>(),
    }),
  skipQuestion: (id: string, questionId: string) =>
    apiRequest(`/missions/${id}/questions/${questionId}/skip`, {
      method: 'POST',
      body: {},
      schema: typed<QuestionDto>(),
    }),
  stopQuestions: (id: string) =>
    apiRequest(`/missions/${id}/questions/stop`, {
      method: 'POST',
      body: {},
      schema: typed<StopQuestionsResult>(),
    }),
  generateHypotheses: (id: string) =>
    apiRequest(`/missions/${id}/hypotheses/generate`, {
      method: 'POST',
      body: {},
      schema: typed<StartGuidedResult>(),
    }),
  generateSummary: (id: string) =>
    apiRequest(`/missions/${id}/summary/generate`, {
      method: 'POST',
      body: {},
      schema: typed<StartGuidedResult>(),
    }),
  decideElement: (id: string, elementId: string, decision: DecisionRequest) =>
    apiRequest(`/missions/${id}/elements/${elementId}/decision`, {
      method: 'POST',
      body: decision,
      schema: typed<DecisionResult>(),
    }),
  rollback: (id: string, toVersion: number) =>
    apiRequest(`/missions/${id}/model/rollback`, {
      method: 'POST',
      body: { toVersion },
      schema: typed<CommitResult>(),
    }),

  // Cartographie : BPMN d'un diagramme pour la visionneuse (WP-19)
  bpmnDiagram: (id: string, diagram: string) =>
    apiRequest(`/missions/${id}/bpmn/${encodeURIComponent(diagram)}`, {
      schema: typed<BpmnDiagramDto>(),
    }),
  // Cartographie : enchaînements des processus, niveaux 2 et 3 (WP-17)
  flowOverview: (id: string) =>
    apiRequest(`/missions/${id}/mapping/processes`, { schema: typed<FlowOverviewDto>() }),
  startFlows: (id: string, request: StartFlowRequest) =>
    apiRequest(`/missions/${id}/mapping/flows`, {
      method: 'POST',
      body: request,
      schema: typed<StartFlowResult>(),
    }),
  decideFlow: (id: string, processId: string, decision: FlowDecisionRequest) =>
    apiRequest(`/missions/${id}/mapping/processes/${processId}/decision`, {
      method: 'POST',
      body: decision,
      schema: typed<FlowDecisionResult>(),
    }),

  // Livrables de l'étape 1 et exports du dossier d'analyse (WP-15)
  deliverables: (id: string) =>
    apiRequest(`/missions/${id}/deliverables`, { schema: typed<DeliverablesPreviewDto>() }),
  listExports: (id: string) =>
    apiRequest(`/missions/${id}/exports`, { schema: typed<ExportArtifactDto[]>() }),
  startExport: (id: string, format: ExportFormat) =>
    apiRequest(`/missions/${id}/exports`, {
      method: 'POST',
      body: { format },
      schema: typed<StartExportResult>(),
    }),
  exportDownloadUrl: (id: string, artifactId: string) =>
    apiRequest(`/missions/${id}/exports/${artifactId}/download-url`, {
      schema: typed<PresignedUrlDto>(),
    }),
  // Circuit de validation, commentaires et signalements (WP-16)
  listSubmissions: (id: string) =>
    apiRequest(`/missions/${id}/submissions`, { schema: typed<SubmissionDto[]>() }),
  submissionPreview: (id: string, kind: SubmissionKind) =>
    apiRequest(`/missions/${id}/submissions/preview?kind=${kind}`, {
      schema: typed<SubmissionPreviewDto>(),
    }),
  submit: (id: string, body: CreateSubmissionRequest) =>
    apiRequest(`/missions/${id}/submissions`, {
      method: 'POST',
      body,
      schema: typed<SubmissionDto>(),
    }),
  withdrawSubmission: (id: string, submissionId: string) =>
    apiRequest(`/missions/${id}/submissions/${submissionId}/withdraw`, {
      method: 'POST',
      body: {},
      schema: typed<SubmissionDto>(),
    }),
  validateSubmission: (id: string, submissionId: string, comment?: string) =>
    apiRequest(`/missions/${id}/submissions/${submissionId}/validate`, {
      method: 'POST',
      body: comment === undefined || comment === '' ? {} : { comment },
      schema: typed<ValidateSubmissionResult>(),
    }),
  submissionDocument: (id: string, submissionId: string) =>
    apiRequest(`/missions/${id}/submissions/${submissionId}/document`, {
      schema: typed<DeliverablesPreviewDto>(),
    }),
  submissionElements: (id: string, submissionId: string) =>
    apiRequest(`/missions/${id}/submissions/${submissionId}/elements`, {
      schema: typed<SubmissionElementDto[]>(),
    }),
  submissionDownloadUrl: (id: string, submissionId: string, artifactId: string) =>
    apiRequest(`/missions/${id}/submissions/${submissionId}/exports/${artifactId}/download-url`, {
      schema: typed<PresignedUrlDto>(),
    }),
  startSubmissionExport: (id: string, submissionId: string, format: ExportFormat) =>
    apiRequest(`/missions/${id}/submissions/${submissionId}/exports`, {
      method: 'POST',
      body: { format },
      schema: typed<StartExportResult>(),
    }),
  listComments: (id: string, target?: { targetKind: CommentTargetKind; targetId: string }) =>
    apiRequest(
      `/missions/${id}/comments${
        target === undefined
          ? ''
          : `?targetKind=${target.targetKind}&targetId=${encodeURIComponent(target.targetId)}`
      }`,
      { schema: typed<CommentDto[]>() },
    ),
  createComment: (id: string, body: CreateCommentRequest) =>
    apiRequest(`/missions/${id}/comments`, {
      method: 'POST',
      body,
      schema: typed<CommentDto>(),
    }),
  resolveComment: (id: string, commentId: string, resolved: boolean) =>
    apiRequest(`/missions/${id}/comments/${commentId}/resolve`, {
      method: 'POST',
      body: { resolved },
      schema: typed<CommentDto>(),
    }),
  listNotices: (id: string) =>
    apiRequest(`/missions/${id}/notices`, { schema: typed<NoticeDto[]>() }),
  markNoticesSeen: (id: string, noticeIds: string[]) =>
    apiRequest(`/missions/${id}/notices/seen`, {
      method: 'POST',
      body: { noticeIds },
      schema: typed<{ updated: number }>(),
    }),

  // Notifications du compte
  listNotifications: () => apiRequest('/notifications', { schema: typed<NotificationDto[]>() }),
  readNotifications: (ids?: string[]) =>
    apiRequest('/notifications/read', {
      method: 'POST',
      body: ids === undefined ? {} : { ids },
      schema: typed<{ updated: number }>(),
    }),
};
