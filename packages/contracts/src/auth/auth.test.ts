import { describe, expect, it } from 'vitest';
import {
  acceptInvitationRequestSchema,
  mfaVerifyRequestSchema,
  recoveryRequestSchema,
} from './index.js';

describe('contrats d’authentification', () => {
  it('refuse un mot de passe de moins de 12 caractères', () => {
    const base = { displayName: 'Ada' };
    expect(acceptInvitationRequestSchema.safeParse({ ...base, password: 'court' }).success).toBe(
      false,
    );
    expect(
      acceptInvitationRequestSchema.safeParse({ ...base, password: 'assez-long-12!' }).success,
    ).toBe(true);
  });

  it('exige un code TOTP à 6 chiffres', () => {
    expect(mfaVerifyRequestSchema.safeParse({ code: '123456' }).success).toBe(true);
    expect(mfaVerifyRequestSchema.safeParse({ code: '12345' }).success).toBe(false);
    expect(mfaVerifyRequestSchema.safeParse({ code: 'abcdef' }).success).toBe(false);
  });

  it('normalise un code de secours en majuscules', () => {
    expect(recoveryRequestSchema.parse({ code: ' abcde-fghjk ' }).code).toBe('ABCDE-FGHJK');
  });
});
