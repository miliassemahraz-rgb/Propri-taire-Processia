import type { ExecutionContext } from '@nestjs/common';
import { DEV_PASSWORD, DEV_PASSWORD_HASH } from '@processia/db';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, safeEqual } from './crypto.js';
import { AuthError } from './errors.js';
import { RateLimitGuard } from './guards.js';
import { isWeakPassword, PasswordService } from './passwords.js';

describe('mots de passe', () => {
  it('refuse les mots de passe courts, répétitifs ou compromis', () => {
    expect(isWeakPassword('court')).toBe(true);
    expect(isWeakPassword('aaaaaaaaaaaa')).toBe(true);
    expect(isWeakPassword('abcabcabcabc')).toBe(true);
    expect(isWeakPassword('Password1234')).toBe(true);
    expect(isWeakPassword('Un-mot-de-passe-solide-42')).toBe(false);
  });

  it('hache en argon2id et vérifie', async () => {
    const service = new PasswordService();
    const hash = await service.hash('Un-mot-de-passe-solide-42');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await service.verify(hash, 'Un-mot-de-passe-solide-42')).toBe(true);
    expect(await service.verify(hash, 'autre')).toBe(false);
    expect(await service.verify('pas-un-hash', 'autre')).toBe(false);
  });

  it('le haché du seed correspond au mot de passe de développement documenté', async () => {
    expect(await new PasswordService().verify(DEV_PASSWORD_HASH, DEV_PASSWORD)).toBe(true);
    expect(isWeakPassword(DEV_PASSWORD)).toBe(false);
  });
});

describe('chiffrement du secret TOTP', () => {
  const key = 'une-clef-de-test-de-plus-de-32-caracteres';
  it('se déchiffre avec la même clef et pas avec une autre', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(stored, key)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptSecret(stored, `${key}x`)).toThrow();
  });

  it('compare en temps constant sans lever sur des longueurs différentes', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('limitation de débit par IP', () => {
  const contextFor = (ip: string): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => ({ ip }) }) }) as unknown as ExecutionContext;

  it('refuse au-delà de la limite (429 RATE_LIMITED), par adresse', () => {
    const guard = new RateLimitGuard({ limit: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) expect(guard.canActivate(contextFor('10.0.0.1'))).toBe(true);
    let error: unknown;
    try {
      guard.canActivate(contextFor('10.0.0.1'));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).getStatus()).toBe(429);
    expect((error as AuthError).code).toBe('RATE_LIMITED');
    expect(guard.canActivate(contextFor('10.0.0.2'))).toBe(true);
  });
});
