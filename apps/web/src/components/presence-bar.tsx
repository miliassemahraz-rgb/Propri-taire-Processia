'use client';

import { t } from '@processia/i18n';
import { StatusBadge, type BadgeTone } from '@processia/ui';
import { useCollab, usePresence, type CollabStatus } from '../lib/collab';

const STATUS_TONE: Record<CollabStatus, BadgeTone> = {
  connecting: 'neutral',
  connected: 'success',
  disconnected: 'warning',
  unavailable: 'neutral',
};

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase());
  return letters.join('');
}

/**
 * État de la connexion de coédition et personnes connectées à la mission. Chaque avatar porte une
 * alternative textuelle (nom et statut) ; la couleur ne porte aucune information.
 */
export function PresenceBar() {
  const { status, self } = useCollab();
  const users = usePresence();
  const others = users.filter((user) => user.id !== self.id);

  return (
    <div className="presence">
      <StatusBadge tone={STATUS_TONE[status]}>{t(`collab.status.${status}`)}</StatusBadge>
      {status === 'connected' || users.length > 0 ? (
        <ul className="plain presence-list" aria-label={t('collab.presence.label')}>
          {users.map((user) => (
            <li key={user.id} className="presence-item">
              <span className="avatar" style={{ backgroundColor: user.color }} aria-hidden="true">
                {initials(user.name)}
              </span>
              <span className="pr-visually-hidden">
                {user.id === self.id
                  ? t('collab.presence.self', { name: user.name })
                  : user.view === undefined
                    ? t('collab.presence.connected', { name: user.name })
                    : t('collab.presence.viewing', { name: user.name, view: user.view })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {others.length > 0 ? (
        <p className="muted small" role="status">
          {t('collab.presence.others', { names: others.map((user) => user.name).join(', ') })}
        </p>
      ) : null}
    </div>
  );
}
