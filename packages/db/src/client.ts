import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema> & { $client: pg.Pool };

/**
 * Transaction ouverte par `withMission` : le contexte de mission est posé (RLS active).
 * Les dépôts des tables cloisonnées n'acceptent que ce type (marque `missionScoped`).
 */
export type MissionTx = Parameters<Parameters<Database['transaction']>[0]>[0] & {
  readonly missionScoped: true;
};
/** Transaction sans contexte de mission : pour les tables non cloisonnées. */
export type PlainTx = Parameters<Parameters<Database['transaction']>[0]>[0];

export function createDb(connectionString: string, options: { max?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  return drizzle(pool, { schema });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Exécute `fn` dans une transaction où `app.mission_id` vaut `missionId` (SET LOCAL : le contexte
 * disparaît à la fin de la transaction, aucune fuite entre requêtes d'un même pool).
 */
export async function withMission<T>(
  db: Database,
  missionId: string,
  fn: (tx: MissionTx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(missionId)) throw new Error('withMission : identifiant de mission invalide.');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.mission_id', ${missionId}, true)`);
    return fn(Object.assign(tx, { missionScoped: true as const }));
  });
}

/**
 * Exécute `fn` dans une transaction sans contexte de mission, pour les tables non cloisonnées
 * (utilisateurs, clients, missions, affectations...). Les tables cloisonnées y paraissent vides.
 * `aiUnscoped` autorise en plus les appels IA sans mission (`ai_calls.mission_id` nul).
 */
export async function withoutMission<T>(
  db: Database,
  fn: (tx: PlainTx) => Promise<T>,
  options: { aiUnscoped?: boolean } = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    if (options.aiUnscoped === true) {
      await tx.execute(sql`select set_config('app.ai_unscoped', 'on', true)`);
    }
    return fn(tx);
  });
}

export async function closeDb(db: Database): Promise<void> {
  await db.$client.end();
}
