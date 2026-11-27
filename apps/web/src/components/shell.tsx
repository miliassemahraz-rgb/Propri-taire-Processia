'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { t, type MessageKey } from '@processia/i18n';
import { Button, DialogTrigger, PopoverPanel, SegmentedControl } from '@processia/ui';
import { useMode, type DisplayMode } from '../lib/mode';
import { useRequireSession, useSession } from '../lib/session';

const PAGE = 'page';

interface NavItem {
  href: string;
  label: MessageKey;
}

const MISSIONS_LINK: NavItem = { href: '/missions', label: 'shell.nav.missions' };

const ADMIN_LINKS: NavItem[] = [
  { href: '/administration/utilisateurs', label: 'shell.nav.adminUsers' },
  { href: '/administration/clients', label: 'shell.nav.adminClients' },
  { href: '/administration/ia', label: 'shell.nav.adminAi' },
];

const MODE_OPTIONS: { id: DisplayMode; label: MessageKey }[] = [
  { id: 'simple', label: 'shell.mode.simple' },
  { id: 'expert', label: 'shell.mode.expert' },
];

function NavLink({ href, label }: { href: string; label: MessageKey }) {
  const pathname = usePathname();
  const current = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} className="nav-link" aria-current={current ? PAGE : undefined}>
      {t(label)}
    </Link>
  );
}

/** Centre de notifications : vide à l'incrément 1, il existe pour fixer la place dans la mise en page. */
function NotificationCenter() {
  return (
    <DialogTrigger>
      <Button variant="secondary">{t('shell.notifications.button')}</Button>
      <PopoverPanel title={t('shell.notifications.title')}>
        <p className="muted">{t('shell.notifications.empty')}</p>
      </PopoverPanel>
    </DialogTrigger>
  );
}

/** Mise en page des pages authentifiées : navigation latérale, mode d'affichage, notifications. */
export function AppShell({ children }: { children: ReactNode }) {
  const me = useRequireSession();
  const { logout } = useSession();
  const { mode, setMode } = useMode();

  if (me === null) {
    return (
      <main id="contenu" tabIndex={-1} className="centered">
        <p role="status">{t('shell.loadingSession')}</p>
      </main>
    );
  }

  const isAdmin = me.user.globalRole === 'admin';
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">{t('shell.brand')}</div>
        <nav aria-label={t('a11y.mainNav')} className="nav">
          <NavLink {...MISSIONS_LINK} />
        </nav>
        {isAdmin ? (
          <nav aria-label={t('a11y.adminNav')} className="nav">
            <div className="nav-group" aria-hidden="true">
              {t('shell.nav.admin')}
            </div>
            {ADMIN_LINKS.map((item) => (
              <NavLink key={item.href} {...item} />
            ))}
          </nav>
        ) : null}
        <div className="sidebar-foot">
          <SegmentedControl
            label={t('shell.mode.label')}
            value={mode}
            onChange={(value) => setMode(value as DisplayMode)}
            options={MODE_OPTIONS.map((option) => ({ id: option.id, label: t(option.label) }))}
          />
          <div className="whoami">
            <span>{t('auth.loggedAs', { name: me.user.displayName })}</span>
            <span className="muted">{t(`roles.global.${me.user.globalRole}`)}</span>
          </div>
          <Button variant="secondary" onPress={() => void logout()}>
            {t('auth.logout')}
          </Button>
        </div>
      </aside>
      <div className="content">
        <div className="topbar">
          <NotificationCenter />
        </div>
        <main id="contenu" tabIndex={-1} className="main">
          {children}
        </main>
      </div>
    </div>
  );
}
