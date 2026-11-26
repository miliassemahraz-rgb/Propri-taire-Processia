import pg from 'pg';
import { type Database, type MissionTx, type PlainTx, withMission } from './client.js';
import { migrateDatabase } from './migrate.js';
import type { DbUrls } from './urls.js';

/**
 * Prépare la base de test : amorçage des rôles, migrations, puis vidage de toutes les tables de
 * `public` (sauf l'historique des migrations, qui vit dans le schéma `drizzle`).
 */
export async function resetTestDatabase(urls: DbUrls): Promise<void> {
  await migrateDatabase(urls);
  const client = new pg.Client({ connectionString: urls.admin });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`,
    );
    if (rows.length > 0) {
      const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
      await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await client.end();
  }
}

class Rollback extends Error {
  constructor(readonly value: unknown) {
    super('rollback');
  }
}

/** Exécute `fn` dans une transaction toujours annulée : un test n'a aucun effet durable. */
export async function withRollback<T>(db: Database, fn: (tx: PlainTx) => Promise<T>): Promise<T> {
  try {
    await db.transaction(async (tx) => {
      throw new Rollback(await fn(tx));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value as T;
    throw error;
  }
  throw new Error('withRollback : état inatteignable');
}

/** Comme `withRollback`, avec le contexte de mission posé. */
export async function withMissionRollback<T>(
  db: Database,
  missionId: string,
  fn: (tx: MissionTx) => Promise<T>,
): Promise<T> {
  try {
    await withMission(db, missionId, async (tx) => {
      throw new Rollback(await fn(tx));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value as T;
    throw error;
  }
  throw new Error('withMissionRollback : état inatteignable');
}
