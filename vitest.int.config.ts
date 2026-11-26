import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

/** Lit `.env` si présent, sinon `.env.example` (valeurs de développement sans secret). */
function readDotenv(path: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
  }
  return entries;
}

function loadEnvFile(): Record<string, string> {
  try {
    return readDotenv('.env');
  } catch {
    return readDotenv('.env.example');
  }
}

export default defineConfig({
  resolve: base.resolve ?? {},
  test: {
    include: ['{apps,packages}/**/src/**/*.int.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    env: loadEnvFile(),
    testTimeout: 30_000,
  },
});
