export const OWNER_ROLE = 'processia_owner';
export const APP_ROLE = 'processia_app';

export interface DbUrls {
  /** Compte d'administration du cluster : amorçage des rôles, seed, remise à zéro des tests. */
  admin: string;
  /** `processia_owner` : applique les migrations. */
  owner: string;
  /** `processia_app` : rôle de l'application, soumis à la RLS. */
  app: string;
}

type Env = Record<string, string | undefined>;

/** Remplace le nom de la base dans une URL PostgreSQL. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

/**
 * Détermine les trois URL de connexion depuis l'environnement. Hors production, les identifiants
 * des rôles retombent sur des valeurs de développement (`processia_owner` / `processia_app`).
 * Avec `test: true`, vise la base de test (`DATABASE_TEST_URL`, sinon `processia_test`).
 */
export function resolveDbUrls(env: Env, options: { test?: boolean } = {}): DbUrls {
  const base = env['DATABASE_URL'];
  if (base === undefined) throw new Error('DATABASE_URL est requis.');
  const production = env['NODE_ENV'] === 'production';
  const role = (explicit: string | undefined, name: string): string => {
    if (explicit !== undefined) return explicit;
    if (production) throw new Error(`L'URL du rôle ${name} doit être configurée en production.`);
    return withCredentials(base, name, name);
  };
  const owner = role(env['DATABASE_OWNER_URL'], OWNER_ROLE);
  const app = role(env['DATABASE_APP_URL'], APP_ROLE);
  if (options.test !== true) return { admin: base, owner, app };

  const admin = env['DATABASE_TEST_URL'] ?? withDatabase(base, 'processia_test');
  const database = new URL(admin).pathname.slice(1);
  return {
    admin,
    owner: withDatabase(owner, database),
    app: withDatabase(app, database),
  };
}

/** Identifiants (nom, mot de passe) portés par une URL de rôle. */
export function credentialsOf(url: string): { user: string; password: string } {
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}
