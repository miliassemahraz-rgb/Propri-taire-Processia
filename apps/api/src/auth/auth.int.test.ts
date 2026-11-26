import type { INestApplication } from '@nestjs/common';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadEnv } from '@processia/config/env';
import { CSRF_HEADER, SESSION_COOKIE } from '@processia/contracts';
import {
  DEV_PASSWORD,
  resetTestDatabase,
  resolveDbUrls,
  SEED_IDS,
  seedDevelopment,
} from '@processia/db';
import { generateSync } from 'otplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { ENV } from '../env.js';
import { CLOCK } from './services.js';
import { RATE_LIMIT_OPTIONS } from './guards.js';

// Intégration : exige `pnpm services:up` (postgres, mailpit). Les tests parlent HTTP à une vraie
// application Nest, branchée sur la base `processia_test` avec le rôle `processia_app`.

const MAILPIT = 'http://localhost:8025';
const urls = resolveDbUrls(process.env, { test: true });

/** Horloge pilotable : les tests avancent le temps pour expirer des codes et des verrous. */
let offsetMs = 0;
const clock = { now: (): Date => new Date(Date.now() + offsetMs) };
const advance = (ms: number): void => {
  offsetMs += ms;
};
const epoch = (): number => Math.floor(clock.now().getTime() / 1000);
const code = (secret: string, at = epoch()): string => generateSync({ secret, epoch: at });

@Controller('test-business')
class BusinessController {
  @Get()
  read(): { ok: boolean } {
    return { ok: true };
  }
  @Post()
  write(): { ok: boolean } {
    return { ok: true };
  }
}
@Module({ controllers: [BusinessController] })
class BusinessModule {}

let app: INestApplication;
let base: string;
let admin: pg.Pool;

interface Reply {
  status: number;
  body: Record<string, unknown>;
  setCookie: string[];
}

/** Client HTTP minimal avec jar de cookies et jeton CSRF courant. */
class Client {
  cookie: string | undefined;
  csrf: string | undefined;

  async call(
    method: string,
    path: string,
    body?: unknown,
    options: { csrf?: boolean | string } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie !== undefined) headers['cookie'] = this.cookie;
    const csrf = options.csrf ?? true;
    if (typeof csrf === 'string') headers[CSRF_HEADER] = csrf;
    else if (csrf && this.csrf !== undefined) headers[CSRF_HEADER] = this.csrf;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = res.headers.getSetCookie();
    for (const line of setCookie) {
      const [pair] = line.split(';');
      if (pair?.startsWith(`${SESSION_COOKIE}=`)) {
        this.cookie = pair.endsWith('=') ? undefined : pair;
      }
    }
    const text = await res.text();
    const parsed: unknown = text === '' ? {} : JSON.parse(text);
    const reply = { status: res.status, body: parsed as Record<string, unknown>, setCookie };
    if (typeof reply.body['csrfToken'] === 'string') this.csrf = reply.body['csrfToken'];
    return reply;
  }

  login(email: string, password = DEV_PASSWORD): Promise<Reply> {
    return this.call('POST', '/auth/login', { email, password }, { csrf: false });
  }
}

interface Enrolled {
  client: Client;
  secret: string;
  recoveryCodes: string[];
}

/** Connexion complète d'un compte sans TOTP : mot de passe, enrôlement, confirmation. */
async function enrolAccount(email: string, password = DEV_PASSWORD): Promise<Enrolled> {
  const client = new Client();
  const login = await client.login(email, password);
  expect(login.status).toBe(200);
  expect(login.body['next']).toBe('mfa_enroll');
  const enroll = await client.call('POST', '/auth/mfa/enroll');
  expect(enroll.status).toBe(200);
  const secret = enroll.body['manualEntryKey'] as string;
  const confirm = await client.call('POST', '/auth/mfa/confirm', { code: code(secret) });
  expect(confirm.status).toBe(200);
  return { client, secret, recoveryCodes: confirm.body['recoveryCodes'] as string[] };
}

/** Nouvelle connexion d'un compte déjà enrôlé, jusqu'à la saisie du TOTP. */
async function loginWithTotp(email: string, secret: string): Promise<Client> {
  const client = new Client();
  expect((await client.login(email)).body['next']).toBe('mfa_verify');
  advance(31_000); // pas de temps suivant : le code du pas précédent est déjà consommé
  const verify = await client.call('POST', '/auth/mfa/verify', { code: code(secret) });
  expect(verify.status).toBe(200);
  return client;
}

async function lastMailTo(email: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const list = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json()) as { messages: { ID: string }[] };
    const first = list.messages[0];
    if (first !== undefined) {
      const detail = (await (await fetch(`${MAILPIT}/api/v1/message/${first.ID}`)).json()) as {
        Text: string;
      };
      return detail.Text;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Aucun courriel reçu pour ${email}`);
}

const countAudit = async (action: string): Promise<number> =>
  Number(
    (
      await admin.query<{ n: string }>('select count(*) as n from audit_log where action = $1', [
        action,
      ])
    ).rows[0]?.n,
  );

beforeAll(async () => {
  await resetTestDatabase(urls);
  await seedDevelopment(urls.admin);
  admin = new pg.Pool({ connectionString: urls.admin, max: 2 });
  const env = loadEnv({ ...process.env, DATABASE_APP_URL: urls.app });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, BusinessModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(RATE_LIMIT_OPTIONS)
    .useValue({ limit: 10_000, windowMs: 60_000 })
    .compile();
  app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
});

afterAll(async () => {
  await app.close();
  await admin.end();
});

describe('WP-05 : acceptation', () => {
  it('1. sans double authentification, toute route métier renvoie 401 MFA_REQUIRED', async () => {
    const anonymous = new Client();
    const none = await anonymous.call('GET', '/test-business');
    expect(none.status).toBe(401);
    expect(none.body['code']).toBe('UNAUTHENTICATED');

    const client = new Client();
    await client.login('admin@processia.local');
    const read = await client.call('GET', '/test-business');
    expect(read.status).toBe(401);
    expect(read.body['code']).toBe('MFA_REQUIRED');
    const write = await client.call('POST', '/test-business', {});
    expect(write.status).toBe(401);
    expect(write.body['code']).toBe('MFA_REQUIRED');

    // /me reste lisible pendant l'enrôlement : il indique l'étape à franchir.
    const me = await client.call('GET', '/me');
    expect(me.status).toBe(200);
    expect(me.body['mfaVerified']).toBe(false);

    // Après l'enrôlement, la même session ouvre l'accès.
    const enroll = await client.call('POST', '/auth/mfa/enroll');
    expect(enroll.body['qrCodeDataUrl']).toMatch(/^data:image\/png;base64,/);
    expect(enroll.body['otpauthUri']).toMatch(/^otpauth:\/\/totp\//);
    const secret = enroll.body['manualEntryKey'] as string;
    const confirm = await client.call('POST', '/auth/mfa/confirm', { code: code(secret) });
    expect(confirm.status).toBe(200);
    expect((confirm.body['recoveryCodes'] as string[]).length).toBe(10);
    expect((await client.call('GET', '/test-business')).status).toBe(200);
    expect(((await client.call('GET', '/me')).body['user'] as { email: string }).email).toBe(
      'admin@processia.local',
    );
  });

  it('2. un TOTP valide ouvre la session ; un TOTP rejoué ou expiré est refusé', async () => {
    const { client: first, secret } = await enrolAccount('responsable@processia.local');
    await first.call('POST', '/auth/logout');

    // Valide.
    const ok = await loginWithTotp('responsable@processia.local', secret);
    expect((await ok.call('GET', '/test-business')).status).toBe(200);

    // Rejoué : le code du pas déjà consommé est refusé, même dans la fenêtre de tolérance.
    const used = code(secret);
    const replay = new Client();
    await replay.login('responsable@processia.local');
    const replayed = await replay.call('POST', '/auth/mfa/verify', { code: used });
    expect(replayed.status).toBe(401);
    expect(replayed.body['code']).toBe('INVALID_CODE');

    // Expiré : un code vieux de plusieurs pas de temps est refusé.
    const stale = code(secret, epoch() - 120);
    advance(31_000);
    const expired = await replay.call('POST', '/auth/mfa/verify', { code: stale });
    expect(expired.status).toBe(401);
    expect(expired.body['code']).toBe('INVALID_CODE');

    // Et le bon code courant passe toujours (2 échecs ne verrouillent pas le compte).
    const good = await replay.call('POST', '/auth/mfa/verify', { code: code(secret) });
    expect(good.status).toBe(200);
  });

  it('3. un code de secours n’est utilisable qu’une fois', async () => {
    const { client, recoveryCodes } = await enrolAccount('consultante1@processia.local');
    await client.call('POST', '/auth/logout');
    const [first, second] = recoveryCodes;
    expect(first).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const a = new Client();
    await a.login('consultante1@processia.local');
    const used = await a.call('POST', '/auth/recovery', { code: first });
    expect(used.status).toBe(200);
    expect(used.body['remainingRecoveryCodes']).toBe(9);
    expect((await a.call('GET', '/test-business')).status).toBe(200);

    const b = new Client();
    await b.login('consultante1@processia.local');
    const again = await b.call('POST', '/auth/recovery', { code: first });
    expect(again.status).toBe(401);
    expect(again.body['code']).toBe('INVALID_CODE');
    const other = await b.call('POST', '/auth/recovery', { code: (second ?? '').toLowerCase() });
    expect(other.status).toBe(200);
    expect(other.body['remainingRecoveryCodes']).toBe(8);
  });

  it('4. six échecs de connexion bloquent le compte temporairement', async () => {
    const client = new Client();
    for (let i = 1; i <= 5; i++) {
      const bad = await client.login('consultant2@processia.local', 'mauvais-mot-de-passe');
      expect(bad.status).toBe(401);
      expect(bad.body['code']).toBe('INVALID_CREDENTIALS');
    }
    const sixth = await client.login('consultant2@processia.local', 'mauvais-mot-de-passe');
    expect(sixth.status).toBe(429);
    expect(sixth.body['code']).toBe('ACCOUNT_LOCKED');

    // Même avec le bon mot de passe, le compte reste bloqué...
    const blocked = await client.login('consultant2@processia.local');
    expect(blocked.status).toBe(429);
    expect(blocked.body['code']).toBe('ACCOUNT_LOCKED');
    expect(await countAudit('auth.account_locked')).toBe(1);

    // ... jusqu'à la fin du blocage temporaire.
    advance(16 * 60_000);
    const later = await client.login('consultant2@processia.local');
    expect(later.status).toBe(200);
  });

  it('5. un POST sans jeton CSRF renvoie 403', async () => {
    const { client, secret } = await enrolAccount('validateur@processia.local');
    const missing = await client.call('POST', '/test-business', {}, { csrf: false });
    expect(missing.status).toBe(403);
    expect(missing.body['code']).toBe('CSRF_INVALID');
    const wrong = await client.call('POST', '/test-business', {}, { csrf: 'faux' });
    expect(wrong.status).toBe(403);
    const logoutWithout = await client.call('POST', '/auth/logout', undefined, { csrf: false });
    expect(logoutWithout.status).toBe(403);
    expect((await client.call('POST', '/test-business', {})).status).toBe(201);
    // Les GET n'exigent pas de jeton.
    expect((await client.call('GET', '/test-business', undefined, { csrf: false })).status).toBe(
      200,
    );
    // L'étape de second facteur est elle aussi protégée.
    const pre = new Client();
    await pre.login('validateur@processia.local');
    advance(31_000);
    const noToken = await pre.call(
      'POST',
      '/auth/mfa/verify',
      { code: code(secret) },
      { csrf: false },
    );
    expect(noToken.status).toBe(403);
  });

  it('6. un lien d’invitation est utilisable une seule fois et expire', async () => {
    // L'administrateur de démonstration s'est enrôlé au test 1 : on se reconnecte avec son secret.
    const adminSecret = await secretOf(SEED_IDS.admin);
    const admin1 = await loginWithTotp('admin@processia.local', adminSecret);

    // Réservé à l'administrateur.
    const consultant = await secretOf(SEED_IDS.consultantA);
    const consultantClient = await loginWithTotp('consultante1@processia.local', consultant);
    const denied = await consultantClient.call('POST', '/invitations', {
      email: 'nouveau@example.test',
      globalRole: 'consultant',
    });
    expect(denied.status).toBe(403);

    const created = await admin1.call('POST', '/invitations', {
      email: 'nouveau@example.test',
      globalRole: 'consultant',
      missionId: SEED_IDS.mission,
      missionRole: 'consultant',
    });
    expect(created.status).toBe(201);
    const mail = await lastMailTo('nouveau@example.test');
    const token = /\/invitations\/([\w-]+)/.exec(mail)?.[1];
    expect(token).toBeDefined();

    const anonymous = new Client();
    // Un mot de passe trop faible est refusé sans consommer l'invitation.
    const weak = await anonymous.call(
      'POST',
      `/invitations/${token}/accept`,
      { displayName: 'Nina Nouvelle', password: 'password1234' },
      { csrf: false },
    );
    expect(weak.status).toBe(422);
    expect(weak.body['code']).toBe('WEAK_PASSWORD');
    const accepted = await anonymous.call(
      'POST',
      `/invitations/${token}/accept`,
      { displayName: 'Nina Nouvelle', password: 'Un-mot-de-passe-solide-42' },
      { csrf: false },
    );
    expect(accepted.status).toBe(200);
    const reused = await anonymous.call(
      'POST',
      `/invitations/${token}/accept`,
      { displayName: 'Autre', password: 'Un-autre-mot-de-passe-42' },
      { csrf: false },
    );
    expect(reused.status).toBe(410);
    expect(reused.body['code']).toBe('INVITATION_INVALID');

    // Le compte créé peut se connecter et il est rattaché à la mission.
    const fresh = new Client();
    const login = await fresh.login('nouveau@example.test', 'Un-mot-de-passe-solide-42');
    expect(login.body['next']).toBe('mfa_enroll');
    const membership = await admin.query(
      `select 1 from mission_members m join users u on u.id = m.user_id where u.email = 'nouveau@example.test'`,
    );
    expect(membership.rowCount).toBe(1);

    // Expiration (72 h) : on date l'invitation dans le passé.
    const second = await admin1.call('POST', '/invitations', {
      email: 'trop-tard@example.test',
      globalRole: 'client_validator',
    });
    expect(second.status).toBe(201);
    const lateToken = /\/invitations\/([\w-]+)/.exec(
      await lastMailTo('trop-tard@example.test'),
    )?.[1];
    await admin.query(
      `update invitations set expires_at = now() - interval '1 minute' where email = 'trop-tard@example.test'`,
    );
    const late = await anonymous.call(
      'POST',
      `/invitations/${lateToken}/accept`,
      { displayName: 'Tardif', password: 'Un-mot-de-passe-solide-42' },
      { csrf: false },
    );
    expect(late.status).toBe(410);
    expect(late.body['code']).toBe('INVITATION_INVALID');
    const unknown = await anonymous.call(
      'POST',
      '/invitations/jeton-inconnu/accept',
      { displayName: 'X', password: 'Un-mot-de-passe-solide-42' },
      { csrf: false },
    );
    expect(unknown.status).toBe(410);
  });

  it('7. les cookies portent HttpOnly, Secure et SameSite=Strict', async () => {
    const secret = await secretOf(SEED_IDS.admin);
    const client = new Client();
    const login = await client.login('admin@processia.local');
    const after = await (async () => {
      advance(31_000);
      return client.call('POST', '/auth/mfa/verify', { code: code(secret) });
    })();
    for (const reply of [login, after]) {
      const line = reply.setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
      expect(line).toBeDefined();
      expect(line).toMatch(/;\s*HttpOnly/i);
      expect(line).toMatch(/;\s*Secure/i);
      expect(line).toMatch(/;\s*SameSite=Strict/i);
      expect(line).toMatch(/;\s*Path=\//i);
      expect(line).not.toMatch(/;\s*Domain=/i);
    }
  });
});

describe('WP-05 : comportements complémentaires', () => {
  it('renouvelle l’identifiant de session et ferme l’ancienne session', async () => {
    const secret = await secretOf(SEED_IDS.admin);
    const client = new Client();
    await client.login('admin@processia.local');
    const preMfaCookie = client.cookie;
    advance(31_000);
    await client.call('POST', '/auth/mfa/verify', { code: code(secret) });
    expect(client.cookie).not.toBe(preMfaCookie);
    const stale = new Client();
    stale.cookie = preMfaCookie;
    expect((await stale.call('GET', '/me')).status).toBe(401);
  });

  it('déconnecte, et expire la session après 30 minutes d’inactivité', async () => {
    const secret = await secretOf(SEED_IDS.admin);
    const client = await loginWithTotp('admin@processia.local', secret);
    const cookie = client.cookie;
    expect((await client.call('POST', '/auth/logout')).status).toBe(204);
    const old = new Client();
    old.cookie = cookie;
    expect((await old.call('GET', '/me')).status).toBe(401);

    const idle = await loginWithTotp('admin@processia.local', secret);
    advance(31 * 60_000);
    expect((await idle.call('GET', '/test-business')).status).toBe(401);
  });

  it('journalise les événements d’authentification dans audit_log', async () => {
    for (const action of [
      'auth.login_succeeded',
      'auth.login_failed',
      'auth.mfa_enrolled',
      'auth.mfa_verified',
      'auth.recovery_used',
      'auth.logout',
      'auth.invitation_created',
      'auth.invitation_accepted',
      'auth.account_locked',
    ]) {
      expect(await countAudit(action), action).toBeGreaterThan(0);
    }
  });

  it('ne stocke ni mot de passe, ni secret TOTP, ni jeton en clair', async () => {
    const { rows } = await admin.query<{ totp_secret_enc: string; id_hash: string }>(
      `select u.totp_secret_enc, s.id_hash from users u join sessions s on s.user_id = u.id
       where u.totp_secret_enc is not null limit 1`,
    );
    expect(rows[0]?.totp_secret_enc).toMatch(/^v1\./);
    expect(rows[0]?.id_hash).toMatch(/^[0-9a-f]{64}$/);
    const hashes = await admin.query<{ password_hash: string }>('select password_hash from users');
    for (const row of hashes.rows) expect(row.password_hash).toMatch(/^\$argon2id\$/);
  });
});

async function secretOf(userId: string): Promise<string> {
  const { rows } = await admin.query<{ totp_secret_enc: string }>(
    'select totp_secret_enc from users where id = $1',
    [userId],
  );
  const stored = rows[0]?.totp_secret_enc;
  if (stored === undefined) throw new Error('Secret TOTP absent');
  const { decryptSecret } = await import('./crypto.js');
  return decryptSecret(
    stored,
    loadEnv({ ...process.env, DATABASE_APP_URL: urls.app }).SESSION_SECRET,
  );
}
