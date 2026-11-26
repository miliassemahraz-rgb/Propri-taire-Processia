import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { PASSWORD_MIN_LENGTH } from '@processia/contracts';

/**
 * Liste locale de mots de passe courants ou compromis (spécification 3.4). Volontairement courte :
 * elle écarte les plus fréquents sans dépendre d'un service externe ; WP-25 pourra la remplacer
 * par une liste plus large. Comparaison en minuscules, sans espaces.
 */
const COMPROMISED = new Set([
  'password1234',
  'password12345',
  'password123456',
  'motdepasse123',
  'motdepasse1234',
  'motdepasse12345',
  '123456789012',
  '1234567890123',
  'azertyuiop12',
  'azertyuiopqsdf',
  'qwertyuiop12',
  'qwertyuiopasdf',
  'azerty123456',
  'qwerty123456',
  'azertyazerty',
  'qwertyqwerty',
  'letmein12345',
  'welcome12345',
  'bienvenue123',
  'bienvenue1234',
  'iloveyou1234',
  'administrator',
  'administrateur',
  'admin1234567',
  'admin12345678',
  'changeme1234',
  'changemenow1',
  'passw0rd1234',
  'p@ssw0rd1234',
  'p@ssword1234',
  'processia1234',
  'processia12345',
  'processiaprocessia',
  'abcdefghijkl',
  'abcd12345678',
  '000000000000',
  '111111111111',
  'aaaaaaaaaaaa',
  'trustno1trustno1',
  'monmotdepasse',
  'monmotdepasse1',
  'monmotdepasse123',
  'superman12345',
  'football12345',
  'marseille1234',
  'doudou123456',
  'soleil123456',
  'chocolat12345',
  'princesse1234',
]);

export function isWeakPassword(password: string): boolean {
  if (password.length < PASSWORD_MIN_LENGTH) return true;
  const normalized = password.toLowerCase().replace(/\s+/g, '');
  if (COMPROMISED.has(normalized)) return true;
  // Un seul caractère répété, ou une courte séquence répétée.
  return /^(.{1,3})\1+$/.test(normalized);
}

@Injectable()
export class PasswordService {
  /** Haché argon2id (paramètres par défaut de la bibliothèque : OWASP). */
  hash(password: string): Promise<string> {
    return hash(password);
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  isWeak(password: string): boolean {
    return isWeakPassword(password);
  }
}
