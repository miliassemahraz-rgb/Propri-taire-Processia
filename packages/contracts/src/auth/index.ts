import { z } from 'zod';

/** Contrats d'authentification (WP-05). Les codes d'erreur sont stables : le web s'y appuie. */

export const AUTH_ERROR_CODES = [
  'UNAUTHENTICATED',
  'MFA_REQUIRED',
  'CSRF_INVALID',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'RATE_LIMITED',
  'INVALID_CODE',
  'MFA_ALREADY_ENROLLED',
  'MFA_NOT_ENROLLED',
  'INVITATION_INVALID',
  'WEAK_PASSWORD',
  'ACCOUNT_EXISTS',
  'FORBIDDEN',
  'VALIDATION_ERROR',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  code: z.enum(AUTH_ERROR_CODES),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const GLOBAL_ROLES = ['admin', 'mission_manager', 'consultant', 'client_validator'] as const;
export const globalRoleSchema = z.enum(GLOBAL_ROLES);
export type GlobalRole = z.infer<typeof globalRoleSchema>;

export const MISSION_ROLES = ['manager', 'consultant', 'validator'] as const;

/** Nom de l'en-tête portant le jeton CSRF, et du cookie de session. */
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_COOKIE = '__Host-sid';

export const PASSWORD_MIN_LENGTH = 12;
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(256);

/** Code TOTP à 6 chiffres. */
export const totpCodeSchema = z.string().regex(/^\d{6}$/);

export const loginRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Étape suivante après le mot de passe : enrôler le TOTP (première connexion) ou le saisir. */
export const mfaStepSchema = z.enum(['mfa_verify', 'mfa_enroll']);
export type MfaStep = z.infer<typeof mfaStepSchema>;

export const loginResponseSchema = z.object({
  next: mfaStepSchema,
  csrfToken: z.string(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const mfaVerifyRequestSchema = z.object({ code: totpCodeSchema });
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;

export const meUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  globalRole: globalRoleSchema,
});
export type MeUser = z.infer<typeof meUserSchema>;

/** Réponse commune aux étapes qui ouvrent la session (identifiant renouvelé, nouveau jeton CSRF). */
export const sessionOpenedResponseSchema = z.object({
  csrfToken: z.string(),
  user: meUserSchema,
});
export type SessionOpenedResponse = z.infer<typeof sessionOpenedResponseSchema>;

export const mfaEnrollResponseSchema = z.object({
  /** URI `otpauth://` encodée dans le QR code. */
  otpauthUri: z.string(),
  /** QR code en `data:image/png;base64,...`. */
  qrCodeDataUrl: z.string(),
  /** Secret en base32, pour la saisie manuelle. */
  manualEntryKey: z.string(),
});
export type MfaEnrollResponse = z.infer<typeof mfaEnrollResponseSchema>;

export const mfaConfirmRequestSchema = z.object({ code: totpCodeSchema });
export type MfaConfirmRequest = z.infer<typeof mfaConfirmRequestSchema>;

export const RECOVERY_CODE_COUNT = 10;
export const mfaConfirmResponseSchema = sessionOpenedResponseSchema.extend({
  /** Codes de secours : affichés une seule fois. */
  recoveryCodes: z.array(z.string()).length(RECOVERY_CODE_COUNT),
});
export type MfaConfirmResponse = z.infer<typeof mfaConfirmResponseSchema>;

export const recoveryRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .min(8)
    .max(32)
    .transform((value) => value.toUpperCase()),
});
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;

export const recoveryResponseSchema = sessionOpenedResponseSchema.extend({
  remainingRecoveryCodes: z.number().int().min(0),
});
export type RecoveryResponse = z.infer<typeof recoveryResponseSchema>;

export const acceptInvitationRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  password: passwordSchema,
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

export const createInvitationRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  globalRole: globalRoleSchema,
  missionId: z.string().uuid().optional(),
  missionRole: z.enum(MISSION_ROLES).optional(),
});
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

export const createInvitationResponseSchema = z.object({
  id: z.string().uuid(),
  expiresAt: z.string(),
});
export type CreateInvitationResponse = z.infer<typeof createInvitationResponseSchema>;

export const meResponseSchema = z.object({
  user: meUserSchema,
  /** `true` quand la session a passé la double authentification. */
  mfaVerified: z.boolean(),
  /** `true` quand l'utilisateur a enrôlé un TOTP. */
  mfaEnrolled: z.boolean(),
  csrfToken: z.string(),
  expiresAt: z.string(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
