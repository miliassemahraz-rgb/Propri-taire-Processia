import { HttpException } from '@nestjs/common';
import type { AuthErrorCode } from '@processia/contracts';

const MESSAGES: Record<AuthErrorCode, string> = {
  UNAUTHENTICATED: 'Authentification requise.',
  MFA_REQUIRED: 'La double authentification est requise.',
  CSRF_INVALID: 'Jeton CSRF absent ou invalide.',
  INVALID_CREDENTIALS: 'Identifiant ou mot de passe incorrect.',
  ACCOUNT_LOCKED: 'Compte temporairement verrouillé après trop d’échecs.',
  RATE_LIMITED: 'Trop de requêtes, réessayez plus tard.',
  INVALID_CODE: 'Code invalide ou expiré.',
  MFA_ALREADY_ENROLLED: 'La double authentification est déjà configurée.',
  MFA_NOT_ENROLLED: 'La double authentification n’est pas encore configurée.',
  INVITATION_INVALID: 'Invitation invalide, expirée ou déjà utilisée.',
  WEAK_PASSWORD: 'Mot de passe trop faible ou compromis.',
  ACCOUNT_EXISTS: 'Un compte existe déjà pour cette adresse.',
  FORBIDDEN: 'Action non autorisée.',
  VALIDATION_ERROR: 'Requête invalide.',
  NOT_FOUND: 'Ressource introuvable.',
  CONFLICT: 'Conflit avec l’état actuel de la ressource.',
  POLICY_NOT_ACCEPTED: 'La politique de données du fournisseur doit être acceptée.',
  STALE: 'Le modèle a changé depuis la version de départ de la modification.',
  CHANGESET_INVALID: 'La modification est refusée par les règles du modèle.',
  PHASE_REGRESSION: 'Retour impossible à une phase déjà validée par le client.',
};

const STATUS: Record<AuthErrorCode, number> = {
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  CSRF_INVALID: 403,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 429,
  RATE_LIMITED: 429,
  INVALID_CODE: 401,
  MFA_ALREADY_ENROLLED: 409,
  MFA_NOT_ENROLLED: 409,
  INVITATION_INVALID: 410,
  WEAK_PASSWORD: 422,
  ACCOUNT_EXISTS: 409,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  POLICY_NOT_ACCEPTED: 422,
  STALE: 409,
  CHANGESET_INVALID: 422,
  PHASE_REGRESSION: 409,
};

/** Erreur applicative portant un code stable (contrat `ApiError`). */
export class AuthError extends HttpException {
  constructor(
    readonly code: AuthErrorCode,
    details?: unknown,
  ) {
    super(
      { code, message: MESSAGES[code], ...(details === undefined ? {} : { details }) },
      STATUS[code],
    );
  }
}
