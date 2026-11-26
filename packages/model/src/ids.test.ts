import { describe, expect, it } from 'vitest';
import { isTempId, isUuidV7, sequentialIdGenerator, tempId, uuidv7 } from './ids.js';

describe('ids', () => {
  it('uuidv7 est déterministe, de version 7 et variante RFC', () => {
    const rnd = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const id = uuidv7(1_700_000_000_000, rnd);
    expect(id).toBe(uuidv7(1_700_000_000_000, rnd));
    expect(isUuidV7(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19] ?? '');
    expect(id.startsWith('018bcfe5-6800')).toBe(true);
  });

  it('uuidv7 est ordonné par horodatage', () => {
    const rnd = new Uint8Array(10);
    expect(uuidv7(1000, rnd) < uuidv7(2000, rnd)).toBe(true);
  });

  it('uuidv7 refuse les paramètres invalides', () => {
    expect(() => uuidv7(-1, new Uint8Array(10))).toThrow(RangeError);
    expect(() => uuidv7(1.5, new Uint8Array(10))).toThrow(RangeError);
    expect(() => uuidv7(1, new Uint8Array(5))).toThrow(RangeError);
  });

  it('reconnaît les identifiants temporaires', () => {
    expect(isTempId(tempId(3))).toBe(true);
    expect(isTempId('tmp:')).toBe(false);
    expect(isTempId(3)).toBe(false);
    expect(isUuidV7('tmp:3')).toBe(false);
    expect(isUuidV7(42)).toBe(false);
    expect(() => tempId(-1)).toThrow(RangeError);
  });

  it('le générateur séquentiel produit des UUID v7 distincts et reproductibles', () => {
    const a = sequentialIdGenerator();
    const b = sequentialIdGenerator();
    const first = a();
    expect(first).toBe(b());
    expect(a()).not.toBe(first);
    expect(isUuidV7(first)).toBe(true);
    expect(isUuidV7(sequentialIdGenerator(7)())).toBe(true);
  });
});
