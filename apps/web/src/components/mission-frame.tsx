'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { MissionSummary } from '@processia/contracts';
import { t } from '@processia/i18n';
import { Notice, StatusBadge } from '@processia/ui';
import { CollabProvider } from '../lib/collab';
import { errorMessage } from '../lib/errors';
import { useSession } from '../lib/session';
import { PresenceBar } from './presence-bar';
import { endpoints } from '../lib/endpoints';

const MissionContext = createContext<MissionSummary | null>(null);

/** Mission courante, disponible sous `MissionFrame`. */
export function useMission(): MissionSummary {
  const mission = useContext(MissionContext);
  if (mission === null) throw new Error('useMission doit être appelé sous MissionFrame.');
  return mission;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; mission: MissionSummary; simulated: boolean };

/** En-tête de mission, bandeau « IA simulée » et navigation propre à la mission. */
export function MissionFrame({ children }: { children: ReactNode }) {
  const params = useParams<{ missionId: string }>();
  const missionId = params.missionId;
  const pathname = usePathname();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const { state: session } = useSession();

  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: 'loading' });
    (async () => {
      try {
        const [mission, ai] = await Promise.all([
          endpoints.getMission(missionId),
          endpoints.aiStatus(missionId),
        ]);
        if (!cancelled) setLoaded({ status: 'ready', mission, simulated: ai.simulated });
      } catch (error) {
        if (!cancelled) setLoaded({ status: 'error', message: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  if (loaded.status === 'loading') return <p role="status">{t('ui.loading')}</p>;
  if (loaded.status === 'error') {
    return (
      <Notice tone="danger" role="alert">
        {loaded.message}
      </Notice>
    );
  }

  const { mission, simulated } = loaded;
  if (session.status !== 'ready') return <p role="status">{t('ui.loading')}</p>;
  const base = `/missions/${missionId}`;
  const links = [
    { href: base, label: t('shell.nav.dashboard') },
    { href: `${base}/analyse`, label: t('shell.nav.analysis') },
    { href: `${base}/equipe`, label: t('shell.nav.team') },
  ];

  return (
    <MissionContext.Provider value={mission}>
      <CollabProvider missionId={mission.id} myRole={mission.myRole} user={session.me.user}>
        {simulated ? (
          <div className="sim-banner" role="note">
            <strong>{t('shell.simulatedAi.banner')}</strong>
            <span>{t('shell.simulatedAi.detail')}</span>
          </div>
        ) : null}
        <header className="mission-header">
          <div>
            <p className="muted small">{mission.clientName}</p>
            <p className="mission-name">{mission.name}</p>
          </div>
          <div className="mission-badges">
            <StatusBadge tone="info">{t(`phases.${mission.phase}`)}</StatusBadge>
            {mission.myRole === null ? <StatusBadge>{t('missions.readOnly')}</StatusBadge> : null}
          </div>
          <PresenceBar />
        </header>
        <nav aria-label={t('a11y.missionNav')} className="subnav">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="subnav-link"
              aria-current={pathname === link.href ? 'page' : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        {children}
      </CollabProvider>
    </MissionContext.Provider>
  );
}
