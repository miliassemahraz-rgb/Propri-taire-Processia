import { readFileSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';
import { buildBusinessModelJsonSchema } from './json-schema.js';
import { CORPUS, cloneMinimal } from './testing/corpus.js';
import { parseModel } from './parse.js';

let cached: Promise<ValidateFunction> | undefined;

/** Compile le JSON Schema une seule fois (le chargement d'ajv-formats passe par import dynamique : interopérabilité CJS). */
function makeValidator(): Promise<ValidateFunction> {
  cached ??= import('ajv-formats').then(({ default: addFormats }) => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    (addFormats as unknown as (a: Ajv) => void)(ajv);
    return ajv.compile(buildBusinessModelJsonSchema());
  });
  return cached;
}

describe('critère 3 : le JSON Schema exporté valide les mêmes jeux (ajv)', () => {
  it('le JSON Schema se compile avec ajv', async () => {
    const validate = await makeValidator();
    expect(typeof validate).toBe('function');
  });

  for (const c of CORPUS) {
    it(`${c.valid ? 'accepte' : 'rejette'} : ${c.name}`, async () => {
      const validate = await makeValidator();
      const data = JSON.parse(JSON.stringify(c.mutate(cloneMinimal())));
      expect(validate(data), JSON.stringify(validate.errors?.slice(0, 3))).toBe(c.valid);
      // Parité avec zod.
      expect(parseModel(data).ok).toBe(c.valid);
    });
  }

  it('schema/business-model.v1.json est à jour', () => {
    const url = new URL('../schema/business-model.v1.json', import.meta.url);
    const committed = JSON.parse(readFileSync(url, 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildBusinessModelJsonSchema())));
  });
});
