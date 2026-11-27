import { t, type MessageKey } from '@processia/i18n';
import type { ClientErrorCode } from './api';
import { ApiRequestError } from './api';

/** Un message en français pour chaque code d'erreur de l'API (liste fermée : le typage la vérifie). */
export const ERROR_MESSAGE_KEYS: Record<ClientErrorCode, MessageKey> = {
  UNAUTHENTICATED: 'errors.UNAUTHENTICATED',
  MFA_REQUIRED: 'errors.MFA_REQUIRED',
  CSRF_INVALID: 'errors.CSRF_INVALID',
  INVALID_CREDENTIALS: 'errors.INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'errors.ACCOUNT_LOCKED',
  RATE_LIMITED: 'errors.RATE_LIMITED',
  INVALID_CODE: 'errors.INVALID_CODE',
  MFA_ALREADY_ENROLLED: 'errors.MFA_ALREADY_ENROLLED',
  MFA_NOT_ENROLLED: 'errors.MFA_NOT_ENROLLED',
  INVITATION_INVALID: 'errors.INVITATION_INVALID',
  WEAK_PASSWORD: 'errors.WEAK_PASSWORD',
  ACCOUNT_EXISTS: 'errors.ACCOUNT_EXISTS',
  FORBIDDEN: 'errors.FORBIDDEN',
  VALIDATION_ERROR: 'errors.VALIDATION_ERROR',
  NOT_FOUND: 'errors.NOT_FOUND',
  CONFLICT: 'errors.CONFLICT',
  POLICY_NOT_ACCEPTED: 'errors.POLICY_NOT_ACCEPTED',
  STALE: 'errors.STALE',
  CHANGESET_INVALID: 'errors.CHANGESET_INVALID',
  PHASE_REGRESSION: 'errors.PHASE_REGRESSION',
  FILE_TOO_LARGE: 'errors.FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'errors.UNSUPPORTED_FILE_TYPE',
  NETWORK: 'errors.NETWORK',
  UNKNOWN: 'errors.UNKNOWN',
};

/** Message affichable pour une erreur quelconque (jamais le texte brut du serveur). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    // Une analyse est déjà en cours : le conflit a une cause précise (WP-12).
    const reason = (error.details as { reason?: unknown } | undefined)?.reason;
    if (error.code === 'CONFLICT' && reason === 'ANALYSIS_IN_PROGRESS') {
      return t('errors.ANALYSIS_IN_PROGRESS');
    }
    if (error.code === 'CONFLICT' && reason === 'ALREADY_DECIDED') {
      return t('errors.ALREADY_DECIDED');
    }
    if (error.code === 'CONFLICT' && reason === 'QUESTION_NOT_OPEN') {
      return t('errors.QUESTION_NOT_OPEN');
    }
    if (error.code === 'CONFLICT' && reason === 'GUIDED_IN_PROGRESS') {
      return t('errors.GUIDED_IN_PROGRESS');
    }
    return t(ERROR_MESSAGE_KEYS[error.code]);
  }
  return t('errors.UNKNOWN');
}
