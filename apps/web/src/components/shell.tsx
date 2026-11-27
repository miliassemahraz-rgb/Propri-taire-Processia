'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { NotificationDto } from '@processia/contracts';
import { t, type MessageKey } from '@processia/i18n';
import { Button, DialogTrigger, PopoverPanel, SegmentedControl } from '@processia/ui';
import { endpoints } from '../lib/endpoints';
import { useMode, type DisplayMode } from '../lib/mode';
import { useRequireSession, useSession } from '../lib/session';
import { notificationHref, payloadCount, payloadText, unreadCount } from '../lib/validation';

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

const NOTIFICATIONS_POLL_MS = 15_000;

/** Texte d'une notification (les messages sont dans le catalogue i18n, jamais dans la base). */
function notificationText(item: NotificationDto): string {
  const text = (key: string): string => payloadText(item.payload, key);
  switch (item.kind) {
    case 'submission.submitted':
      return t('shell.notifications.kinds.submission.submitted', {
        kind: text('kindLabel'),
        round: text('round'),
        version: text('version'),
      });
    case 'submission.validated':
      return t('shell.notifications.kinds.submission.validated', {
        kind: text('kindLabel'),
        name: text('validatorName'),
      });
    case 'submission.withdrawn':
      return t('shell.notifications.kinds.submission.withdrawn', {
        kind: text('kindLabel'),
        round: text('round'),
      });
    case 'comment.created':
      return t('shell.notifications.kinds.comment.created', {
        name: text('authorName'),
        excerpt: text('excerpt'),
      });
    case 'post_validation_notice':
      return t('shell.notifications.kinds.post_validation_notice', {
        version: text('version'),
        count: payloadCount(item.payload, 'elementIds'),
      });
    case 'export.done':
      return t('shell.notifications.kinds.export.done', {
        format: text('format'),
        version: text('version'),
      });
    case 'export.failed':
      return t('shell.notifications.kinds.export.failed');
    default:
      return t('shell.notifications.kinds.other');
  }
}

/** Centre de notifications : relève régulière, nombre de non lues, marquage « lu » (WP-16). */
function NotificationCenter() {
  const [items, setItems] = useState<NotificationDto[]>([]);

  const refresh = useCallback(async () => {
    try {
      setItems(await endpoints.listNotifications());
    } catch {
      // Hors session ou réseau coupé : la liste reste telle quelle.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), NOTIFICATIONS_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const unread = unreadCount(items);

  async function markAll(): Promise<void> {
    try {
      await endpoints.readNotifications();
      await refresh();
    } catch {
      // Sans effet : la liste est relue à la prochaine relève.
    }
  }

  return (
    <DialogTrigger>
      <Button variant="secondary" data-testid="notifications-button" onPress={() => void refresh()}>
        {unread > 0
          ? t('shell.notifications.buttonUnread', { count: unread })
          : t('shell.notifications.button')}
      </Button>
      <PopoverPanel title={t('shell.notifications.title')}>
        {items.length === 0 ? (
          <p className="muted">{t('shell.notifications.empty')}</p>
        ) : (
          <div className="stack-sm">
            {unread > 0 ? (
              <Button variant="quiet" onPress={() => void markAll()}>
                {t('shell.notifications.markAll')}
              </Button>
            ) : null}
            <ul className="plain" data-testid="notifications-list">
              {items.map((item) => {
                const href = notificationHref(item);
                return (
                  <li key={item.id} className="notification-item">
                    <span className={item.readAt === null ? 'strong' : 'muted'}>
                      {notificationText(item)}
                    </span>{' '}
                    {href === null ? null : (
                      <Link href={href}>{t('shell.notifications.openLink')}</Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
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
