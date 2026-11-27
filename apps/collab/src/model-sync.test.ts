import { MODEL_ELEMENTS_MAP, MODEL_META_MAP, parseDocName } from '@processia/contracts';
import type { BusinessModel, ModelDiff } from '@processia/model';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CollabDenied, verifyCollabToken } from './access.js';
import { jsonEqual, reconcileModelDoc } from './model-sync.js';

const meta = { authorId: null, at: null };
const el = (id: string, label: string) => ({ id, label, nested: { a: [1, 2] } });
const model = (version: number, elements: Record<string, unknown>): BusinessModel =>
  ({
    schemaVersion: 1,
    missionId: 'm',
    version,
    elements,
    rejectedHypotheses: [],
    layout: {},
  }) as unknown as BusinessModel;

function changedKeys(doc: Y.Doc, run: () => void): string[] {
  const keys: string[] = [];
  doc.getMap(MODEL_ELEMENTS_MAP).observe((e) => keys.push(...e.keysChanged));
  run();
  return keys;
}

describe('jsonEqual', () => {
  it('ignore l’ordre des clés, pas les valeurs', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual([1], [1, 2])).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });
});

describe('reconcileModelDoc', () => {
  it('écrit uniquement la différence minimale', () => {
    const doc = new Y.Doc();
    const v1 = model(1, { A: el('A', 'a'), B: el('B', 'b'), C: el('C', 'c') });
    expect(reconcileModelDoc(doc, v1, meta)).toMatchObject({ added: 3, changed: true });

    const v2 = model(2, { A: el('A', 'a'), B: el('B', 'b2'), D: el('D', 'd') });
    const diff: ModelDiff = {
      added: ['D'],
      removed: ['C'],
      modified: [{ id: 'B', fields: ['label'] }],
      layout: [],
    };
    const keys = changedKeys(doc, () => reconcileModelDoc(doc, v2, meta, diff));
    expect(new Set(keys)).toEqual(new Set(['B', 'C', 'D']));
    expect(doc.getMap(MODEL_META_MAP).get('version')).toBe(2);
    expect([...doc.getMap(MODEL_ELEMENTS_MAP).keys()].sort()).toEqual(['A', 'B', 'D']);
  });

  it('sans changement, ne produit aucune mise à jour', () => {
    const doc = new Y.Doc();
    const v1 = model(1, { A: el('A', 'a') });
    reconcileModelDoc(doc, v1, meta);
    let updates = 0;
    doc.on('update', () => (updates += 1));
    expect(reconcileModelDoc(doc, v1, meta).changed).toBe(false);
    expect(updates).toBe(0);
  });

  it('se rattrape par comparaison complète quand le diff ne suit pas la version du document', () => {
    const doc = new Y.Doc();
    reconcileModelDoc(doc, model(1, { A: el('A', 'a'), B: el('B', 'b') }), meta);
    // Version 3 alors que le document est en 1 : le diff de 3 ne cite pas B (retiré en 2).
    const diff: ModelDiff = { added: ['C'], removed: [], modified: [], layout: [] };
    reconcileModelDoc(doc, model(3, { A: el('A', 'a'), C: el('C', 'c') }), meta, diff);
    expect([...doc.getMap(MODEL_ELEMENTS_MAP).keys()].sort()).toEqual(['A', 'C']);
  });

  it('une mission sans version donne un modèle vide en version 0', () => {
    const doc = new Y.Doc();
    reconcileModelDoc(doc, null, meta);
    expect(doc.getMap(MODEL_ELEMENTS_MAP).size).toBe(0);
    expect(doc.getMap(MODEL_META_MAP).get('version')).toBe(0);
  });
});

describe('noms de documents et jetons', () => {
  const mission = '00000000-0000-7000-8000-000000000002';
  it('analyse les noms de document', () => {
    expect(parseDocName(`mission:${mission}:model`)).toEqual({ missionId: mission, kind: 'model' });
    expect(parseDocName(`mission:${mission}:workspace`)?.kind).toBe('workspace');
    expect(parseDocName(`mission:${mission}:autre`)).toBeNull();
    expect(parseDocName('mission:x:model')).toBeNull();
  });

  it('refuse un jeton mal signé, sans émetteur ou sans mission', async () => {
    const secret = 'z'.repeat(40);
    const key = new TextEncoder().encode(secret);
    const bare = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).sign(key);
    await expect(verifyCollabToken(bare, secret)).rejects.toBeInstanceOf(CollabDenied);
    await expect(verifyCollabToken('abc', secret)).rejects.toBeInstanceOf(CollabDenied);
  });
});
