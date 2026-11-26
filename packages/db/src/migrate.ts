import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { APP_ROLE, credentialsOf, OWNER_ROLE, type DbUrls } from './urls.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Verrou consultatif : sérialise les amorçages concurrents (tests en parallèle, plusieurs agents). */
const BOOTSTRAP_LOCK = 7_040_001;

/**
 * Amorçage, avec le compte d'administration : crée (ou met à jour) les rôles `processia_owner` et
 * `processia_app` (sans SUPERUSER ni BYPASSRLS), donne la base au propriétaire et lui remet le
 * schéma `public`. Idempotent. Les mots de passe viennent des URL des rôles.
 */
export async function bootstrapRoles(urls: DbUrls): Promise<void> {
  const client = new pg.Client({ connectionString: urls.admin });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [BOOTSTRAP_LOCK]);
    const database = (await client.query<{ db: string }>('select current_database() as db')).rows[0]
      ?.db;
    if (database === undefined) throw new Error('Nom de base introuvable.');
    const roles: [string, string][] = [
      [OWNER_ROLE, credentialsOf(urls.owner).password],
      [APP_ROLE, credentialsOf(urls.app).password],
    ];
    for (const [role, password] of roles) {
      const exists = await client.query('select 1 from pg_roles where rolname = $1', [role]);
      const create = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
      const statement = await client.query<{ s: string }>(
        `select format('${create} ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) as s`,
        [role, password],
      );
      await client.query(statement.rows[0]?.s ?? '');
    }
    const grants = await client.query<{ s: string }>(
      `select format('GRANT CONNECT, CREATE ON DATABASE %I TO %I', $1::text, $2::text) as s
       union all select format('GRANT CONNECT ON DATABASE %I TO %I', $1::text, $3::text)
       union all select format('ALTER SCHEMA public OWNER TO %I', $2::text)`,
      [database, OWNER_ROLE, APP_ROLE],
    );
    for (const row of grants.rows) await client.query(row.s);
  } finally {
    await client.query('select pg_advisory_unlock($1)', [BOOTSTRAP_LOCK]).catch(() => undefined);
    await client.end();
  }
}

/** Applique les migrations SQL avec `processia_owner`. Idempotent. */
export async function applyMigrations(urls: DbUrls): Promise<void> {
  // Verrou sur une connexion dédiée : deux migrations simultanées s'exécutent l'une après l'autre.
  const lock = new pg.Client({ connectionString: urls.owner });
  await lock.connect();
  const pool = new pg.Pool({ connectionString: urls.owner, max: 1 });
  try {
    await lock.query('select pg_advisory_lock($1)', [BOOTSTRAP_LOCK + 1]);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
    await lock.end();
  }
}

/** Amorçage des rôles puis migrations : ce que fait `pnpm db:migrate`. */
export async function migrateDatabase(urls: DbUrls): Promise<void> {
  await bootstrapRoles(urls);
  await applyMigrations(urls);
}
