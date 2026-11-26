import { describe, expect, it } from 'vitest';
import { credentialsOf, resolveDbUrls, withDatabase } from './urls.js';
import { MISSION_SCOPED_TABLES } from './schema/index.js';

const base = 'postgres://processia:secret@localhost:5432/processia';

describe('@processia/db : URL de connexion', () => {
  it('dérive les rôles propriétaire et applicatif en développement', () => {
    const urls = resolveDbUrls({ DATABASE_URL: base });
    expect(urls.admin).toBe(base);
    expect(credentialsOf(urls.owner).user).toBe('processia_owner');
    expect(credentialsOf(urls.app).user).toBe('processia_app');
  });

  it('vise la base de test sans toucher aux identifiants', () => {
    const urls = resolveDbUrls({ DATABASE_URL: base }, { test: true });
    expect(new URL(urls.admin).pathname).toBe('/processia_test');
    expect(new URL(urls.app).pathname).toBe('/processia_test');
    expect(credentialsOf(urls.app).user).toBe('processia_app');
  });

  it('exige les URL des rôles en production', () => {
    expect(() => resolveDbUrls({ DATABASE_URL: base, NODE_ENV: 'production' })).toThrow();
  });

  it('remplace le nom de la base', () => {
    expect(withDatabase(base, 'autre')).toContain('/autre');
  });
});

describe('@processia/db : schéma', () => {
  it('liste 15 tables cloisonnées, sans doublon', () => {
    expect(new Set(MISSION_SCOPED_TABLES).size).toBe(MISSION_SCOPED_TABLES.length);
    expect(MISSION_SCOPED_TABLES).toHaveLength(15);
  });
});
