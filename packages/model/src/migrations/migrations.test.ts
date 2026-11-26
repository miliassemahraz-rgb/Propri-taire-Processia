import { describe, expect, it } from 'vitest';
import { parseModel } from '../parse.js';
import { buildMinimalModel } from '../testing/minimal-model.js';
import { CURRENT_SCHEMA_VERSION, type Migration, migrateToCurrent } from './index.js';

describe('cadre de migrations', () => {
  it('la version 1 est la version courante et ne migre rien', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
    const result = migrateToCurrent({ schemaVersion: 1 });
    expect(result).toEqual({ ok: true, value: { schemaVersion: 1 }, migrated: false });
  });

  it('applique la chaîne de migrations jusqu’à la cible', () => {
    const chain: Migration[] = [
      { from: 1, to: 2, migrate: (m) => ({ ...m, a: 1 }) },
      { from: 2, to: 3, migrate: (m) => ({ ...m, b: 2 }) },
    ];
    const result = migrateToCurrent({ schemaVersion: 1 }, chain, 3);
    expect(result).toEqual({ ok: true, value: { schemaVersion: 3, a: 1, b: 2 }, migrated: true });
  });

  it('signale une migration manquante', () => {
    const result = migrateToCurrent({ schemaVersion: 1 }, [], 2);
    expect(result.ok).toBe(false);
  });

  it('refuse une version plus récente ou absente, ou une entrée non objet', () => {
    expect(migrateToCurrent({ schemaVersion: 9 }).ok).toBe(false);
    expect(migrateToCurrent({}).ok).toBe(false);
    expect(migrateToCurrent({ schemaVersion: 1.5 }).ok).toBe(false);
    expect(migrateToCurrent(null).ok).toBe(false);
    expect(migrateToCurrent([]).ok).toBe(false);
  });

  it('parseModel signale schemaVersion en cas d’échec de migration', () => {
    const result = parseModel({ ...buildMinimalModel(), schemaVersion: 7 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toBe('schemaVersion');
  });
});
