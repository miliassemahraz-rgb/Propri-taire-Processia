// Utilisé uniquement pour `drizzle-kit generate` (les migrations sont appliquées par scripts/migrate.mjs).
export default {
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
};
