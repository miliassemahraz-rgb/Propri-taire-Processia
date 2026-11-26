/**
 * Cadre des migrations de schéma (spécification 1.2 et 2.5).
 *
 * Toute évolution du schéma du modèle ajoute une migration `vX_to_vY.ts` ici, enregistrée dans
 * `MIGRATIONS`, et s'applique aux instantanés stockés avant leur validation par zod.
 * Version 1 : aucune migration (le schéma courant est la version 1).
 */
export const CURRENT_SCHEMA_VERSION = 1 as const;

export interface Migration {
  from: number;
  to: number;
  /** Fonction pure : ne modifie pas son argument. */
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/** Migrations enregistrées, de la plus ancienne à la plus récente. Vide en version 1. */
export const MIGRATIONS: readonly Migration[] = [];

export type MigrationResult =
  { ok: true; value: unknown; migrated: boolean } | { ok: false; error: string };

/**
 * Amène un instantané brut à `CURRENT_SCHEMA_VERSION`. Les paramètres `migrations` et `target`
 * permettent de tester le cadre avec des migrations fictives.
 */
export function migrateToCurrent(
  raw: unknown,
  migrations: readonly Migration[] = MIGRATIONS,
  target: number = CURRENT_SCHEMA_VERSION,
): MigrationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Le modèle doit être un objet JSON' };
  }
  let current = raw as Record<string, unknown>;
  const declared = current.schemaVersion;
  if (typeof declared !== 'number' || !Number.isInteger(declared)) {
    return { ok: false, error: 'schemaVersion absent ou invalide' };
  }
  let version: number = declared;
  if (version > target) {
    return {
      ok: false,
      error: `schemaVersion ${version} plus récent que la version prise en charge (${target})`,
    };
  }
  let migrated = false;
  while (version < target) {
    const step = migrations.find((m) => m.from === version);
    if (!step) {
      return { ok: false, error: `Aucune migration depuis la version ${version}` };
    }
    current = { ...step.migrate(current), schemaVersion: step.to };
    version = step.to;
    migrated = true;
  }
  return { ok: true, value: current, migrated };
}
