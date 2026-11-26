import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCollabServer } from './server.js';

const server = createCollabServer({ port: 0, address: '127.0.0.1', quiet: true });

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
