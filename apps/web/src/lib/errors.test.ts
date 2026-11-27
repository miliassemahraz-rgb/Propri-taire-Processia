import { describe, expect, it } from 'vitest';
import { AUTH_ERROR_CODES } from '@processia/contracts';
import { t } from '@processia/i18n';
import { ApiRequestError } from './api';
import { ERROR_MESSAGE_KEYS, errorMessage } from './errors';

describe('traduction des codes d’erreur de l’API', () => {
  it('couvre chaque code de contrat, plus les erreurs réseau et inconnues', () => {
    for (const code of AUTH_ERROR_CODES) {
      expect(ERROR_MESSAGE_KEYS[code], code).toBeDefined();
      expect(t(ERROR_MESSAGE_KEYS[code]).length, code).toBeGreaterThan(10);
    }
    expect(Object.keys(ERROR_MESSAGE_KEYS).sort()).toEqual(
      [...AUTH_ERROR_CODES, 'NETWORK', 'UNKNOWN'].sort(),
    );
  });

  it('affiche un message français plutôt que le texte du serveur', () => {
    expect(errorMessage(new ApiRequestError('ACCOUNT_LOCKED', 429))).toMatch(/verrouillé/);
    expect(errorMessage(new ApiRequestError('MFA_REQUIRED', 401))).toMatch(
      /double authentification/,
    );
    expect(errorMessage(new ApiRequestError('STALE', 409))).toMatch(/modifié/);
    expect(errorMessage(new Error('boom'))).toBe(t('errors.UNKNOWN'));
  });

  it('le message de chaque avertissement de capacité existe', () => {
    expect(t('warnings.CAPABILITY_MISSING.documents')).toMatch(/documents/);
    expect(t('warnings.CAPABILITY_MISSING.text')).toMatch(/texte/);
  });
});
