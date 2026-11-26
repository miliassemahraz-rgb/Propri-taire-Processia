import { loadEnv } from '@processia/config/env';
import { closeDb, createDb, users } from '@processia/db';
import { eq } from 'drizzle-orm';
import { generateSync } from 'otplib';
import { appDatabaseUrl } from '../db/db.module.js';
import { decryptSecret } from '../auth/crypto.js';

/**
 * Outil de DÉVELOPPEMENT : affiche le code TOTP courant d'un compte déjà enrôlé, pour se connecter
 * sans application d'authentification. Usage : `pnpm --filter @processia/api dev:totp <email>`.
 * Refuse de tourner en production.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') throw new Error('dev:totp est réservé au développement.');
  const email = process.argv[2];
  if (email === undefined) throw new Error('Usage : dev:totp <email>');
  const db = createDb(appDatabaseUrl(env), { max: 1 });
  try {
    const [user] = await db
      .select({ secret: users.totpSecretEnc, enabled: users.totpEnabledAt })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (user?.secret === undefined || user.secret === null)
      throw new Error(`Aucun TOTP enrôlé pour ${email}.`);
    const code = generateSync({ secret: decryptSecret(user.secret, env.SESSION_SECRET) });
    console.info(code);
  } finally {
    await closeDb(db);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
