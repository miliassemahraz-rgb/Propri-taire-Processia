import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Les tests importent les autres paquets par leur code source : aucun build préalable requis.
const alias = [
  // Sous-chemins explicites d'abord (l'ordre compte).
  { find: /^@processia\/config\/env$/, replacement: `${root}packages/config/src/env.ts` },
  ...readdirSync(new URL('./packages', import.meta.url)).map((name) => ({
    find: new RegExp(`^@processia/${name}$`),
    replacement: `${root}packages/${name}/src/index.ts`,
  })),
];

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['{apps,packages}/**/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'],
    environment: 'node',
  },
});
