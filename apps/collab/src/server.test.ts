import { createDb } from '@processia/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCollabServer } from './server.js';

// La connexion à la base est paresseuse : ce test n'exige aucun service.
const db = createDb('postgres://processia_app:processia_app@localhost:5432/processia');
const server = createCollabServer({
  port: 0,
  address: '127.0.0.1',
  quiet: true,
  db,
  jwtSecret: 'x'.repeat(32),
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.destroy();
});

describe('serveur de coédition', () => {
  it('répond en HTTP sur son port', async () => {
    const response = await fetch(server.httpURL);
    expect(response.status).toBe(200);
  });
});
