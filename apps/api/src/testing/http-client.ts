import { CSRF_HEADER, SESSION_COOKIE } from '@processia/contracts';
import { DEV_PASSWORD } from '@processia/db';
import { generateSync } from 'otplib';
import { expect } from 'vitest';

export interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Client HTTP de test : cookie de session, jeton CSRF et connexion complète (TOTP compris). */
export class TestClient {
  cookie: string | undefined;
  csrf: string | undefined;

  constructor(private readonly base: () => string) {}

  async call(method: string, path: string, body?: unknown): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie !== undefined) headers['cookie'] = this.cookie;
    if (this.csrf !== undefined) headers[CSRF_HEADER] = this.csrf;
    const res = await fetch(`${this.base()}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      if (pair?.startsWith(`${SESSION_COOKIE}=`)) this.cookie = pair;
    }
    const text = await res.text();
    const parsed = text === '' ? {} : JSON.parse(text);
    if (typeof parsed.csrfToken === 'string') this.csrf = parsed.csrfToken;
    return { status: res.status, body: parsed };
  }

  /** Dépôt multipart d'un fichier (champ `file`). */
  async upload(path: string, filename: string, content: Uint8Array): Promise<Reply> {
    const headers: Record<string, string> = {};
    if (this.cookie !== undefined) headers['cookie'] = this.cookie;
    if (this.csrf !== undefined) headers[CSRF_HEADER] = this.csrf;
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(content)]), filename);
    const res = await fetch(`${this.base()}${path}`, { method: 'POST', headers, body: form });
    const text = await res.text();
    return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
  }

  async signIn(email: string): Promise<this> {
    expect((await this.call('POST', '/auth/login', { email, password: DEV_PASSWORD })).status).toBe(
      200,
    );
    const enroll = await this.call('POST', '/auth/mfa/enroll');
    const secret = enroll.body.manualEntryKey as string;
    const confirm = await this.call('POST', '/auth/mfa/confirm', {
      code: generateSync({ secret }),
    });
    expect(confirm.status).toBe(200);
    return this;
  }
}
