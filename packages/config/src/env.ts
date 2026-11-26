import { z } from 'zod';

/** Booléen lisible depuis une variable d'environnement ("true" / "false" / "1" / "0"). */
const envBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/**
 * Schéma de validation des variables d'environnement de Processia.
 * Toute variable lue par le code doit figurer ici ET dans `.env.example`.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Base de données
  DATABASE_URL: z.string().url(),
  // Rôles de WP-04 : migrations (propriétaire) et application (non propriétaire, soumis à la RLS).
  // DATABASE_URL reste le compte d'administration du cluster (amorçage des rôles, seed, tests).
  DATABASE_OWNER_URL: z.string().url().optional(),
  DATABASE_APP_URL: z.string().url().optional(),
  DATABASE_TEST_URL: z.string().url().optional(),

  // Stockage objet S3 (MinIO en local)
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: envBoolean.default(true),
  S3_BUCKET_SOURCES: z.string().min(1).default('processia-sources'),
  S3_BUCKET_ARTIFACTS: z.string().min(1).default('processia-artifacts'),

  // Courrier (Mailpit en local)
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_FROM: z.string().min(1).default('Processia <no-reply@processia.local>'),

  // Services applicatifs
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  API_PORT: z.coerce.number().int().positive().default(3001),
  COLLAB_PORT: z.coerce.number().int().positive().default(3002),
  API_URL: z.string().url().default('http://localhost:3001'),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),

  // Secrets applicatifs (WP-05 et WP-10)
  SESSION_SECRET: z.string().min(32),
  COLLAB_JWT_SECRET: z.string().min(32),
  // Chiffrement au repos des clés API des fournisseurs IA (AES-256-GCM, WP-06)
  MASTER_KEY: z.string().min(32),

  // Couche IA (WP-09) : fournisseur factice par défaut
  AI_PROVIDER: z.enum(['fake', 'anthropic']).default('fake'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Force le fournisseur factice, en test et en développement (spec 4.1). */
  AI_PROVIDER_OVERRIDE: z.enum(['fake']).optional(),
  /** `1` : écrit les réponses réelles comme enregistrements rejouables (spec 4.2). */
  AI_RECORD: z.enum(['0', '1']).optional(),
  /** Dossier des enregistrements `<pipeline>/<inputHash>.json` du fournisseur factice. */
  AI_RECORDINGS_DIR: z.string().min(1).optional(),
  /** URL de base de l'API du fournisseur (serveur simulé en test) ; absente : API officielle. */
  AI_BASE_URL: z.string().url().optional(),
  /** Table de prix JSON (euros par million de jetons) pour l'estimation du coût. */
  AI_PRICE_TABLE: z.string().min(2).optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Valide et retourne l'environnement. Lève une erreur lisible (variables en cause)
 * plutôt que de laisser l'application démarrer avec une configuration incomplète.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join('\n');
    throw new Error(`Variables d'environnement invalides :\n${details}`);
  }
  return result.data;
}
