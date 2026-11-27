'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ClientDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import { Button, DataTable, Notice, showToast, TextField } from '@processia/ui';
import { endpoints } from '../lib/endpoints';
import { errorMessage } from '../lib/errors';
import { formatDate } from '../lib/format';

export function AdminClientsPage() {
  const [clients, setClients] = useState<ClientDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [retention, setRetention] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    endpoints.listClients().then(setClients, (caught: unknown) => setError(errorMessage(caught)));
  }, []);
  useEffect(load, [load]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const months = retention.trim() === '' ? undefined : Number(retention);
      const created = await endpoints.createClient({
        name,
        ...(months === undefined ? {} : { defaultRetentionMonths: months }),
      });
      showToast({
        tone: 'success',
        title: t('admin.clients.create.created', { name: created.name }),
      });
      setName('');
      setRetention('');
      load();
    } catch (caught) {
      setFormError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <div className="stack-lg">
      <div>
        <h1>{t('admin.clients.heading')}</h1>
        <p className="muted">{t('admin.clients.intro')}</p>
      </div>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {clients !== null && clients.length === 0 ? (
        <Notice tone="info">{t('admin.clients.empty')}</Notice>
      ) : null}
      {clients !== null && clients.length > 0 ? (
        <DataTable caption={t('admin.clients.table.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('admin.clients.table.name')}</th>
              <th scope="col">{t('admin.clients.table.retention')}</th>
              <th scope="col">{t('admin.clients.table.created')}</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={client.id}>
                <td className="strong">{client.name}</td>
                <td>{client.defaultRetentionMonths}</td>
                <td>{formatDate(client.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : null}
      <form onSubmit={(event) => void onSubmit(event)} className="card stack">
        <h2 className="h3">{t('admin.clients.create.heading')}</h2>
        {formError ? (
          <Notice tone="danger" role="alert">
            {formError}
          </Notice>
        ) : null}
        <TextField
          label={t('admin.clients.create.name')}
          isRequired
          value={name}
          onChange={setName}
          maxLength={200}
        />
        <TextField
          label={t('admin.clients.create.retention')}
          description={t('admin.clients.create.retentionHint')}
          inputMode="numeric"
          value={retention}
          onChange={setRetention}
        />
        <div>
          <Button type="submit" isDisabled={busy || name.trim() === ''}>
            {t('admin.clients.create.submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}
