import { apiErrorSchema, CSRF_HEADER, type AuthErrorCode } from '@processia/contracts';
import type { z } from 'zod';

/** Préfixe des appels : l'API est relayée par Next sous le même domaine (cookie SameSite=Strict). */
export const API_PREFIX = '/api';

export type ClientErrorCode = AuthErrorCode | 'NETWORK' | 'UNKNOWN';

/** Erreur d'API : `code` est stable et sert à choisir le message affiché (voir `errors.ts`). */
export class ApiRequestError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(code);
    this.name = 'ApiRequestError';
  }
}

let csrfToken: string | null = null;

/** Jeton CSRF courant (renvoyé par la connexion et par `/me`), rejoué sur chaque requête non GET. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export interface RequestOptions<S extends z.ZodType | undefined> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Corps multipart (dépôt de fichier) : l'en-tête `content-type` est posé par le navigateur. */
  form?: FormData;
  /** Schéma zod de la réponse (contrats `@processia/contracts`) ; absent : réponse sans corps. */
  schema?: S;
}

type Result<S> = S extends z.ZodType ? z.output<S> : undefined;

/** Appel typé : la réponse est validée par le schéma du contrat. */
export async function apiRequest<S extends z.ZodType | undefined = undefined>(
  path: string,
  options: RequestOptions<S> = {},
): Promise<Result<S>> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined && options.form === undefined) {
    headers['content-type'] = 'application/json';
  }
  if (method !== 'GET' && csrfToken !== null) headers[CSRF_HEADER] = csrfToken;

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.form !== undefined
        ? { body: options.form }
        : options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiRequestError('NETWORK', 0);
  }

  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    const error = apiErrorSchema.safeParse(parsed);
    if (error.success) {
      throw new ApiRequestError(error.data.code, response.status, error.data.details);
    }
    throw new ApiRequestError('UNKNOWN', response.status);
  }

  if (options.schema === undefined || response.status === 204) {
    return undefined as Result<S>;
  }
  const json: unknown = await response.json();
  const data = options.schema.safeParse(json);
  if (!data.success) throw new ApiRequestError('UNKNOWN', response.status, data.error.issues);
  return data.data as Result<S>;
}
