'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MfaEnrollResponse } from '@processia/contracts';
import { t } from '@processia/i18n';
import { Button, Notice, TextField } from '@processia/ui';
import { setCsrfToken } from '../lib/api';
import { endpoints } from '../lib/endpoints';
import { errorMessage } from '../lib/errors';
import { pendingAuthStep, useSession } from '../lib/session';

/** Destination après connexion : `?next=` n'est suivi que s'il désigne une page de l'application. */
function nextDestination(): string {
  const value = new URLSearchParams(window.location.search).get('next');
  return value !== null && value.startsWith('/') && !value.startsWith('//') ? value : '/missions';
}

export function LoginForm() {
  const router = useRouter();
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.login({ email, password });
      setCsrfToken(result.csrfToken);
      await refresh();
      const query = window.location.search;
      router.push(
        `${result.next === 'mfa_enroll' ? '/connexion/enrolement' : '/connexion/verification'}${query}`,
      );
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="stack" noValidate={false}>
      <h1>{t('auth.login.heading')}</h1>
      <p className="muted">{t('auth.login.intro')}</p>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      <TextField
        label={t('auth.login.email')}
        type="email"
        name="email"
        autoComplete="username"
        isRequired
        value={email}
        onChange={setEmail}
      />
      <TextField
        label={t('auth.login.password')}
        type="password"
        name="password"
        autoComplete="current-password"
        isRequired
        value={password}
        onChange={setPassword}
      />
      <Button type="submit" isDisabled={busy}>
        {t('auth.login.submit')}
      </Button>
    </form>
  );
}

/** Redirige selon l'étape de connexion réellement en attente (session absente, 2FA déjà faite...). */
function useStepRedirect(
  expected: '/connexion/verification' | '/connexion/enrolement',
  hold = false,
) {
  const router = useRouter();
  const { state } = useSession();
  useEffect(() => {
    if (hold) return;
    if (state.status === 'anonymous') {
      router.replace('/connexion');
    } else if (state.status === 'ready') {
      const step = pendingAuthStep(state.me);
      if (step === null) router.replace(nextDestination());
      else if (step !== expected) router.replace(step);
    }
  }, [state, router, expected, hold]);
}

export function VerifyForm() {
  const router = useRouter();
  const { refresh } = useSession();
  useStepRedirect('/connexion/verification');
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = useRecovery
        ? await endpoints.recovery(code)
        : await endpoints.mfaVerify(code.replace(/\s+/g, ''));
      setCsrfToken(result.csrfToken);
      await refresh();
      router.push(nextDestination());
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="stack">
      <h1>{t('auth.verify.heading')}</h1>
      <p className="muted">{t('auth.verify.intro')}</p>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      <TextField
        key={String(useRecovery)}
        label={useRecovery ? t('auth.verify.recoveryCode') : t('auth.verify.code')}
        description={useRecovery ? t('auth.verify.recoveryHint') : undefined}
        name="code"
        autoComplete="one-time-code"
        inputMode={useRecovery ? 'text' : 'numeric'}
        isRequired
        value={code}
        onChange={setCode}
      />
      <Button type="submit" isDisabled={busy}>
        {t('auth.verify.submit')}
      </Button>
      <Button
        variant="quiet"
        onPress={() => {
          setUseRecovery(!useRecovery);
          setCode('');
          setError(null);
        }}
      >
        {useRecovery ? t('auth.verify.useTotp') : t('auth.verify.useRecovery')}
      </Button>
    </form>
  );
}

export function EnrollForm() {
  const router = useRouter();
  const { refresh } = useSession();
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  useStepRedirect('/connexion/enrolement', recoveryCodes !== null);
  const [enrollment, setEnrollment] = useState<MfaEnrollResponse | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { state } = useSession();
  const started = useRef(false);

  const canEnroll = state.status === 'ready' && !state.me.mfaEnrolled && !state.me.mfaVerified;
  useEffect(() => {
    if (!canEnroll || started.current) return;
    started.current = true;
    endpoints.mfaEnroll().then(setEnrollment, (caught: unknown) => setError(errorMessage(caught)));
  }, [canEnroll]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.mfaConfirm(code.replace(/\s+/g, ''));
      setCsrfToken(result.csrfToken);
      setRecoveryCodes(result.recoveryCodes);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  if (recoveryCodes !== null) {
    return (
      <div className="stack">
        <h1>{t('auth.enroll.recoveryHeading')}</h1>
        <p>{t('auth.enroll.recoveryIntro')}</p>
        <ul className="recovery-codes" aria-label={t('auth.enroll.recoveryList')}>
          {recoveryCodes.map((item) => (
            <li key={item}>
              <code>{item}</code>
            </li>
          ))}
        </ul>
        <Button onPress={() => router.push(nextDestination())}>{t('auth.enroll.continue')}</Button>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="stack">
      <h1>{t('auth.enroll.heading')}</h1>
      <p className="muted">{t('auth.enroll.intro')}</p>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {enrollment ? (
        <>
          {/* Image de données générée par l'API : next/image n'apporte rien ici. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={enrollment.qrCodeDataUrl}
            alt={t('auth.enroll.qrAlt')}
            width={192}
            height={192}
            className="qr"
          />
          <div>
            <p className="label-like">{t('auth.enroll.manualKey')}</p>
            <p>
              <code data-testid="manual-key">{enrollment.manualEntryKey}</code>
            </p>
            <p className="muted small">{t('auth.enroll.manualHint')}</p>
          </div>
        </>
      ) : null}
      <TextField
        label={t('auth.enroll.code')}
        name="code"
        autoComplete="one-time-code"
        inputMode="numeric"
        isRequired
        value={code}
        onChange={setCode}
      />
      <Button type="submit" isDisabled={busy || enrollment === null}>
        {t('auth.enroll.submit')}
      </Button>
    </form>
  );
}

export function InvitationForm() {
  const params = useParams<{ token: string }>();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await endpoints.acceptInvitation(params.token, { displayName, password });
      setDone(true);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="stack">
        <h1>{t('auth.invitation.doneTitle')}</h1>
        <Notice tone="success" role="status">
          {t('auth.invitation.doneBody')}
        </Notice>
        <Link href="/connexion">{t('auth.invitation.goLogin')}</Link>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="stack">
      <h1>{t('auth.invitation.heading')}</h1>
      <p className="muted">{t('auth.invitation.intro')}</p>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      <TextField
        label={t('auth.invitation.displayName')}
        name="displayName"
        autoComplete="name"
        isRequired
        value={displayName}
        onChange={setDisplayName}
      />
      <TextField
        label={t('auth.invitation.password')}
        description={t('auth.invitation.passwordHint')}
        type="password"
        name="password"
        autoComplete="new-password"
        isRequired
        minLength={12}
        value={password}
        onChange={setPassword}
      />
      <Button type="submit" isDisabled={busy}>
        {t('auth.invitation.submit')}
      </Button>
    </form>
  );
}
