import {
  aiConfigSchema,
  aiStatusSchema,
  assignableUserSchema,
  clientSchema,
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
  type AssignMemberRequest,
  type CreateClientRequest,
  type CreateInvitationRequest,
  type CreateMissionRequest,
  type UpdateUserRequest,
  type UpsertAiConfigRequest,
} from '@processia/contracts';
import { z } from 'zod';
import { apiRequest } from './api';

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

  // Modèle (WP-08) : tête de version, pour la complétude du tableau de bord
  headModel: (id: string) =>
    apiRequest(`/missions/${id}/model`, {
      schema: z.object({ version: z.number().int(), model: z.unknown() }),
    }),
};
