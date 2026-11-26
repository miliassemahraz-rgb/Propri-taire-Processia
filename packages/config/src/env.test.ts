import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgres://processia:processia@localhost:5432/processia',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'processia',
  S3_SECRET_KEY: 'processia-secret',
  SESSION_SECRET: 'x'.repeat(32),
  MASTER_KEY: 'm'.repeat(32),
  COLLAB_JWT_SECRET: 'y'.repeat(32),
};

describe('loadEnv', () => {
  it('applique les valeurs par défaut', () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(3001);
    expect(env.AI_PROVIDER).toBe('fake');
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('refuse un secret trop court et nomme la variable', () => {
    expect(() => loadEnv({ ...valid, SESSION_SECRET: 'court' })).toThrow(/SESSION_SECRET/);
  });

  it('refuse une configuration sans base de données', () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });
});
