import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Courriel insensible à la casse (extension `citext`). */
export const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

/** Vecteur de recherche plein texte (colonne générée côté base). */
export const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

/** Contenu binaire (état Yjs). */
export const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Valeur JSON. Les types précis (instantané du modèle, ChangeSet, diff) viennent de
 * `@processia/model`.
 * TODO(WP-02) : typer `snapshot`, `changeSet` et `diff` avec les types du méta-modèle.
 */
export type Json = unknown;

/** Clé primaire uuid v7 (fonction SQL `uuid_v7()`, voir la migration 0000). */
export const pk = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuid_v7()`);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tstz = (name: string) => timestamp(name, { withTimezone: true });
