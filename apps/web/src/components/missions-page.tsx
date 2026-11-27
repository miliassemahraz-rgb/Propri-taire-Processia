'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ClientDto, MissionPhase, MissionSummary } from '@processia/contracts';
import { t } from '@processia/i18n';
import {
  Button,
  DataTable,
  Dialog,
  Notice,
  ProgressMeter,
  Select,
  showToast,
  StatusBadge,
  TextField,
} from '@processia/ui';
import { endpoints } from '../lib/endpoints';
import { errorMessage } from '../lib/errors';
import { useSession } from '../lib/session';

export function phaseTone(phase: MissionPhase): 'info' | 'warning' | 'success' {
  if (phase === 'generation') return 'success';
  if (phase === 'transformation') return 'warning';
  return 'info';
}

function MissionRow({ mission }: { mission: MissionSummary }) {
  const progress = mission.progress;
  return (
    <tr>
      <td>
        <Link href={`/missions/${mission.id}`} className="strong">
          {mission.name}
        </Link>
      </td>
      <td>{mission.clientName}</td>
      <td>
        <StatusBadge tone={phaseTone(mission.phase)}>{t(`phases.${mission.phase}`)}</StatusBadge>
      </td>
      <td>
        {progress === null ? (
          <span className="muted">{t('missions.noProgress')}</span>
        ) : progress.completeness === null ? (
          <span className="muted">{t('missions.noModel')}</span>
        ) : (
          <ProgressMeter
            value={progress.completeness}
            label={t('missions.table.completeness')}
            valueText={t('format.percent', { value: Math.round(progress.completeness * 100) })}
          />
        )}
        {progress !== null && progress.pendingSubmissions > 0 ? (
          <p className="muted small">
            {t('missions.pending', { count: progress.pendingSubmissions })}
          </p>
        ) : null}
      </td>
      <td>
        {mission.myRole === null ? (
          <StatusBadge>{t('missions.readOnly')}</StatusBadge>
        ) : (
          t(`roles.mission.${mission.myRole}`)
        )}
      </td>
    </tr>
  );
}

function CreateMissionDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [clients, setClients] = useState<ClientDto[] | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    endpoints.listClients().then(setClients, (caught: unknown) => setError(errorMessage(caught)));
  }, [isOpen]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (clientId === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.createMission({
        clientId,
        name,
        ...(description.trim() === '' ? {} : { description }),
      });
      showToast({
        tone: 'success',
        title: t('missions.create.created', { name: result.mission.name }),
      });
      for (const warning of result.warnings) {
        showToast({
          tone: 'info',
          title: t(`warnings.CAPABILITY_MISSING.${warning.capability}`),
        });
      }
      onOpenChange(false);
      setName('');
      setDescription('');
      router.push(`/missions/${result.mission.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <Dialog title={t('missions.create.title')} isOpen={isOpen} onOpenChange={onOpenChange}>
      <form onSubmit={(event) => void onSubmit(event)} className="stack">
        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
        {clients !== null && clients.length === 0 ? (
          <Notice tone="warning">{t('missions.create.noClients')}</Notice>
        ) : null}
        <Select
          label={t('missions.create.client')}
          placeholder={t('missions.create.clientPlaceholder')}
          options={(clients ?? []).map((client) => ({ id: client.id, label: client.name }))}
          value={clientId}
          onChange={setClientId}
          isRequired
        />
        <TextField
          label={t('missions.create.name')}
          isRequired
          value={name}
          onChange={setName}
          maxLength={200}
        />
        <TextField
          label={t('missions.create.description')}
          multiline
          value={description}
          onChange={setDescription}
        />
        <div className="row end">
          <Button variant="secondary" onPress={() => onOpenChange(false)}>
            {t('ui.cancel')}
          </Button>
          <Button type="submit" isDisabled={busy || clientId === null || name.trim() === ''}>
            {t('missions.create.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function MissionsPage() {
  const { state } = useSession();
  const [missions, setMissions] = useState<MissionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    endpoints.listMissions().then(setMissions, (caught: unknown) => setError(errorMessage(caught)));
  }, []);
  useEffect(load, [load]);

  const role = state.status === 'ready' ? state.me.user.globalRole : null;
  const canCreate = role === 'admin' || role === 'mission_manager';
  const sees = role === 'admin' || role === 'mission_manager';

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>{t('missions.heading')}</h1>
          <p className="muted">{sees ? t('missions.subtitleAll') : t('missions.subtitleMember')}</p>
        </div>
        {canCreate ? <Button onPress={() => setCreating(true)}>{t('missions.new')}</Button> : null}
      </div>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {missions === null && error === null ? <p role="status">{t('ui.loading')}</p> : null}
      {missions !== null && missions.length === 0 ? (
        <Notice tone="info">
          {canCreate ? t('missions.emptyHint') : t('missions.emptyReader')}
        </Notice>
      ) : null}
      {missions !== null && missions.length > 0 ? (
        <DataTable caption={t('missions.table.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('missions.table.name')}</th>
              <th scope="col">{t('missions.table.client')}</th>
              <th scope="col">{t('missions.table.phase')}</th>
              <th scope="col">{t('missions.table.completeness')}</th>
              <th scope="col">{t('missions.table.team')}</th>
            </tr>
          </thead>
          <tbody>
            {missions.map((mission) => (
              <MissionRow key={mission.id} mission={mission} />
            ))}
          </tbody>
        </DataTable>
      ) : null}
      {canCreate ? (
        <CreateMissionDialog
          isOpen={creating}
          onOpenChange={(open) => {
            setCreating(open);
            if (!open) load();
          }}
        />
      ) : null}
    </div>
  );
}
