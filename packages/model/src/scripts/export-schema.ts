/**
 * Écrit `schema/business-model.v1.json` et `fixtures/minimal-model.json`.
 * Lancé par `pnpm --filter @processia/model schema:export` (puis formaté par Prettier).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBusinessModelJsonSchema } from '../json-schema.js';
import { buildMinimalModel } from '../testing/minimal-model.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function write(relative: string, data: unknown): void {
  const file = resolve(pkgRoot, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.info(`écrit : ${relative}`);
}

write('schema/business-model.v1.json', buildBusinessModelJsonSchema());
write('fixtures/minimal-model.json', buildMinimalModel());
