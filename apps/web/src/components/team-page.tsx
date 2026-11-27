'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  MISSION_ROLES,
  type AssignableUser,
  type GlobalRole,
  type MemberDto,
  type MissionRoleValue,
} from '@processia/contracts';
import { t } from '@processia/i18n';
import { Button, DataTable, Notice, Select, showToast, TextField } from '@processia/ui';
import { endpoints } from '../lib/endpoints';
import { errorMessage } from '../lib/errors';
import { useMission } from './mission-frame';

/** Rôle global du compte à inviter selon le rôle de mission voulu (PO-27, PO-32). */
const GLOBAL_ROLE_FOR: Record<MissionRoleValue, GlobalRole> = {
  manager: 'mission_manager',
  consultant: 'consultant',
  validator: 'client_validator',
};

function AssignForm({ missionId, onChanged }: { missionId: string; onChanged: () => void }) {
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    endpoints
      .assignableUsers(missionId)
      .then(setUsers, (caught: unknown) => setError(errorMessage(caught)));
  }, [missionId]);

  const selected = users.find((user) => user.id === userId);
  const roleOptions = (selected?.assignableRoles ?? []).map((value) => ({
    id: value,
    label: t(`roles.mission.${value}`),
  }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (selected === undefined || role === null) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.assignMember(missionId, {
        userId: selected.id,
        missionRole: role as MissionRoleValue,
      });
      showToast({
        tone: 'success',
        title: t('team.assigned', {
          name: selected.displayName,
          role: t(`roles.mission.${role as MissionRoleValue}`),
        }),
      });
      setUserId(null);
      setRole(null);
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="card stack">
      <h2 className="h3">{t('team.add.heading')}</h2>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {users.length === 0 && error === null ? (
        <p className="muted">{t('team.add.noUsers')}</p>
      ) : null}
      <Select
        label={t('team.add.user')}
        placeholder={t('team.add.userPlaceholder')}
        options={users.map((user) => ({
          id: user.id,
          label: `${user.displayName} (${user.email})`,
        }))}
        value={userId}
        onChange={(value) => {
          setUserId(value);
          setRole(null);
        }}
        isRequired
      />
      <Select
        label={t('team.add.role')}
        placeholder={t('team.add.rolePlaceholder')}
        description={t('team.add.roleHint')}
        options={roleOptions}
        value={role}
        onChange={setRole}
        isDisabled={selected === undefined}
        isRequired
      />
      <div>
        <Button type="submit" isDisabled={busy || selected === undefined || role === null}>
          {t('team.add.submit')}
        </Button>
      </div>
    </form>
  );
}

function InviteForm({ missionId }: { missionId: string }) {
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
      const missionRole = role as MissionRoleValue;
      await endpoints.createInvitation({
        email,
        globalRole: GLOBAL_ROLE_FOR[missionRole],
        missionId,
        missionRole,
      });
      showToast({ tone: 'success', title: t('team.invite.sent', { email }) });
      setEmail('');
      setRole(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="card stack">
      <h2 className="h3">{t('team.invite.heading')}</h2>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      <TextField
        label={t('team.invite.email')}
        type="email"
        isRequired
        value={email}
        onChange={setEmail}
      />
      <Select
        label={t('team.invite.role')}
        placeholder={t('team.invite.rolePlaceholder')}
        options={MISSION_ROLES.map((value) => ({ id: value, label: t(`roles.mission.${value}`) }))}
        value={role}
        onChange={setRole}
        isRequired
      />
      <div>
        <Button type="submit" isDisabled={busy || role === null}>
          {t('team.invite.submit')}
        </Button>
      </div>
    </form>
  );
}

export function TeamPage() {
  const mission = useMission();
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Le responsable (ou l'administrateur) peut modifier l'équipe : `myRole` nul signale une lecture
  // seule pour un non-membre ; la garde de l'API fait foi.
  const canEdit = mission.myRole === 'manager' || mission.myRole === null;

  const load = useCallback(() => {
    endpoints
      .listMembers(mission.id)
      .then(setMembers, (caught: unknown) => setError(errorMessage(caught)));
  }, [mission.id]);
  useEffect(load, [load]);

  async function remove(member: MemberDto) {
    try {
      await endpoints.removeMember(mission.id, member.userId);
      showToast({ tone: 'success', title: t('team.removed', { name: member.displayName }) });
      load();
    } catch (caught) {
      showToast({ tone: 'error', title: errorMessage(caught) });
    }
  }

  return (
    <div className="stack-lg">
      <div>
        <h1>{t('team.heading')}</h1>
        <p className="muted">{t('team.intro')}</p>
      </div>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {members !== null && members.length === 0 ? (
        <Notice tone="info">{t('team.empty')}</Notice>
      ) : null}
      {members !== null && members.length > 0 ? (
        <DataTable caption={t('team.table.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('team.table.name')}</th>
              <th scope="col">{t('team.table.email')}</th>
              <th scope="col">{t('team.table.role')}</th>
              {canEdit ? <th scope="col">{t('team.table.actions')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <td className="strong">{member.displayName}</td>
                <td>{member.email}</td>
                <td>{t(`roles.mission.${member.missionRole}`)}</td>
                {canEdit ? (
                  <td>
                    <Button
                      variant="secondary"
                      aria-label={t('team.remove', { name: member.displayName })}
                      onPress={() => void remove(member)}
                    >
                      {t('team.removeShort')}
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : null}
      {canEdit ? (
        <div className="grid-2">
          <AssignForm missionId={mission.id} onChanged={load} />
          <InviteForm missionId={mission.id} />
        </div>
      ) : (
        <Notice tone="info">{t('team.add.readOnly')}</Notice>
      )}
    </div>
  );
}
