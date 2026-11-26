import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { DEV_PASSWORD_HASH } from './dev-credentials.js';
import * as schema from './schema/index.js';

/** Identifiants fixes : le seed est idempotent et les tests peuvent s'y référer. */
export const SEED_IDS = {
  client: '00000000-0000-7000-8000-000000000001',
  mission: '00000000-0000-7000-8000-000000000002',
  admin: '00000000-0000-7000-8000-0000000000a1',
  manager: '00000000-0000-7000-8000-0000000000a2',
  consultantA: '00000000-0000-7000-8000-0000000000a3',
  consultantB: '00000000-0000-7000-8000-0000000000a4',
  validator: '00000000-0000-7000-8000-0000000000a5',
} as const;

/**
 * Données de développement : un administrateur, un responsable de mission, deux consultants, un
 * validateur, un client et la mission « Cabinet pilote ». À exécuter avec le compte
 * d'administration (la RLS ne s'applique pas à un superutilisateur).
 *
 * Les comptes reçoivent le mot de passe de développement `DEV_PASSWORD` (argon2id) s'ils n'en ont
 * pas encore ; le TOTP s'enrôle à la première connexion (WP-05).
 */
export async function seedDevelopment(adminUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const db = drizzle(pool, { schema });
  try {
    const user = (id: string, email: string, displayName: string, globalRole: string) => ({
      id,
      email,
      displayName,
      globalRole,
      status: 'active',
      passwordHash: DEV_PASSWORD_HASH,
    });
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.users)
        .values([
          user(SEED_IDS.admin, 'admin@processia.local', 'Alice Administratrice', 'admin'),
          user(
            SEED_IDS.manager,
            'responsable@processia.local',
            'Marc Responsable',
            'mission_manager',
          ),
          user(
            SEED_IDS.consultantA,
            'consultante1@processia.local',
            'Camille Consultante',
            'consultant',
          ),
          user(
            SEED_IDS.consultantB,
            'consultant2@processia.local',
            'Claude Consultant',
            'consultant',
          ),
          user(
            SEED_IDS.validator,
            'validateur@processia.local',
            'Valérie Validatrice',
            'client_validator',
          ),
        ])
        .onConflictDoUpdate({
          target: schema.users.id,
          set: {
            passwordHash: sql`coalesce(${schema.users.passwordHash}, excluded.password_hash)`,
          },
        });
      await tx
        .insert(schema.clients)
        .values({ id: SEED_IDS.client, name: 'Cabinet client pilote' })
        .onConflictDoNothing();
      await tx
        .insert(schema.missions)
        .values({
          id: SEED_IDS.mission,
          clientId: SEED_IDS.client,
          name: 'Cabinet pilote',
          description: 'Mission pilote de l’incrément 1.',
          createdBy: SEED_IDS.manager,
        })
        .onConflictDoNothing();
      await tx
        .insert(schema.missionMembers)
        .values([
          { missionId: SEED_IDS.mission, userId: SEED_IDS.manager, missionRole: 'manager' },
          { missionId: SEED_IDS.mission, userId: SEED_IDS.consultantA, missionRole: 'consultant' },
          { missionId: SEED_IDS.mission, userId: SEED_IDS.consultantB, missionRole: 'consultant' },
          { missionId: SEED_IDS.mission, userId: SEED_IDS.validator, missionRole: 'validator' },
        ])
        .onConflictDoNothing();
    });
  } finally {
    await pool.end();
  }
}
