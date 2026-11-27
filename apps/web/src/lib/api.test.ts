import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiRequest, ApiRequestError, setCsrfToken } from './api';

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headersOfCall(mock: ReturnType<typeof vi.fn>, index: number): Record<string, string> {
  const init = mock.mock.calls[index]?.[1] as RequestInit;
  return init.headers as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('client API typé', () => {
  it('envoie le jeton CSRF sur les requêtes non GET seulement', async () => {
    const fetchMock = vi.fn(async () => respond(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    setCsrfToken('jeton-csrf');
    const schema = z.object({ ok: z.boolean() });

    await apiRequest('/missions', { schema });
    await apiRequest('/missions', { method: 'POST', body: { a: 1 }, schema });

    expect(headersOfCall(fetchMock, 0)['x-csrf-token']).toBeUndefined();
    expect(headersOfCall(fetchMock, 1)['x-csrf-token']).toBe('jeton-csrf');
    expect(headersOfCall(fetchMock, 1)['content-type']).toBe('application/json');
  });

  it('transforme une réponse d’erreur en ApiRequestError portant le code stable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(401, { code: 'MFA_REQUIRED', message: 'x' })),
    );
    await expect(apiRequest('/missions')).rejects.toMatchObject({
      name: 'ApiRequestError',
      code: 'MFA_REQUIRED',
      status: 401,
    });
  });

  it('signale une panne réseau et une réponse hors contrat', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(apiRequest('/me')).rejects.toMatchObject({ code: 'NETWORK' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(200, { inattendu: true })),
    );
    await expect(
      apiRequest('/me', { schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('accepte une réponse 204 sans corps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(apiRequest('/auth/logout', { method: 'POST', body: {} })).resolves.toBeUndefined();
  });
});
