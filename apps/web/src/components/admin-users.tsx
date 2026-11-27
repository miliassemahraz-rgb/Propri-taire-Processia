'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { GLOBAL_ROLES, type GlobalRole, type UserSummary } from '@processia/contracts';
import { t } from '@processia/i18n';
import {
  Button,
  DataTable,
  Notice,
  Select,
  showToast,
  StatusBadge,
  TextField,
} from '@processia/ui';
import { endpoints } from '../lib/endpoints';
import { errorMessage } from '../lib/errors';

const ACTIVE = 'active';
const DISABLED = 'disabled';

function setStatus(id: string, status: typeof ACTIVE | typeof DISABLED) {
  return endpoints.updateUser(id, { status });
}

const STATUS_TONE = { invited: 'info', active: 'success', disabled: 'danger' } as const;

function formatDate(value: string | null): string {
  if (value === null) return t('admin.users.never');
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function InviteUserForm() {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (role === null) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.createInvitation({ email, globalRole: role as GlobalRole });
      showToast({ tone: 'success', title: t('admin.users.invite.sent', { email }) });
      setEmail('');
      setRole(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="card stack">
      <h2 className="h3">{t('admin.users.invite.heading')}</h2>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      <TextField
        label={t('admin.users.invite.email')}
        type="email"
        isRequired
        value={email}
        onChange={setEmail}
      />
      <Select
        label={t('admin.users.invite.role')}
        placeholder={t('admin.users.invite.rolePlaceholder')}
        options={GLOBAL_ROLES.map((value) => ({ id: value, label: t(`roles.global.${value}`) }))}
        value={role}
        onChange={setRole}
        isRequired
      />
      <div>
        <Button type="submit" isDisabled={busy || role === null}>
          {t('admin.users.invite.submit')}
        </Button>
      </div>
    </form>
  );
}

export function AdminUsersPage() {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    endpoints.listUsers().then(setUsers, (caught: unknown) => setError(errorMessage(caught)));
  }, []);
  useEffect(load, [load]);

  async function run(action: () => Promise<unknown>, message: string) {
    try {
      await action();
      showToast({ tone: 'success', title: message });
      load();
    } catch (caught) {
      showToast({ tone: 'error', title: errorMessage(caught) });
    }
  }

  return (
    <div className="stack-lg">
      <div>
        <h1>{t('admin.users.heading')}</h1>
        <p className="muted">{t('admin.users.intro')}</p>
      </div>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {users === null && error === null ? <p role="status">{t('ui.loading')}</p> : null}
      {users !== null ? (
        <DataTable caption={t('admin.users.table.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('admin.users.table.name')}</th>
              <th scope="col">{t('admin.users.table.email')}</th>
              <th scope="col">{t('admin.users.table.role')}</th>
              <th scope="col">{t('admin.users.table.status')}</th>
              <th scope="col">{t('admin.users.table.mfa')}</th>
              <th scope="col">{t('admin.users.table.lastLogin')}</th>
              <th scope="col">{t('admin.users.table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td className="strong">{user.displayName}</td>
                <td>{user.email}</td>
                <td>{t(`roles.global.${user.globalRole}`)}</td>
                <td>
                  <StatusBadge tone={STATUS_TONE[user.status]}>
                    {t(`admin.users.status.${user.status}`)}
                  </StatusBadge>
                </td>
                <td>{user.totpEnabled ? t('admin.users.mfaOn') : t('admin.users.mfaOff')}</td>
                <td>{formatDate(user.lastLoginAt)}</td>
                <td>
                  <div className="row">
                    <Button
                      variant="secondary"
                      aria-label={t('admin.users.unlock', { name: user.displayName })}
                      onPress={() =>
                        void run(
                          () => endpoints.unlockUser(user.id),
                          t('admin.users.unlocked', { name: user.displayName }),
                        )
                      }
                    >
                      {t('admin.users.unlockShort')}
                    </Button>
                    {user.status === 'disabled' ? (
                      <Button
                        variant="secondary"
                        aria-label={t('admin.users.enable', { name: user.displayName })}
                        onPress={() =>
                          void run(
                            () => setStatus(user.id, ACTIVE),
                            t('admin.users.statusChanged', { name: user.displayName }),
                          )
                        }
                      >
                        {t('admin.users.enableShort')}
                      </Button>
                    ) : user.status === 'active' ? (
                      <Button
                        variant="secondary"
                        aria-label={t('admin.users.disable', { name: user.displayName })}
                        onPress={() =>
                          void run(
                            () => setStatus(user.id, DISABLED),
                            t('admin.users.statusChanged', { name: user.displayName }),
                          )
                        }
                      >
                        {t('admin.users.disableShort')}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : null}
      <InviteUserForm />
    </div>
  );
}
