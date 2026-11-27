'use client';

import type { NoticeDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import { Button, StatusBadge, showToast } from '@processia/ui';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';

interface Props {
  missionId: string;
  notices: NoticeDto[];
  /** Seul le validateur marque les signalements comme vus. */
  canMarkSeen: boolean;
  onChanged: () => void;
}

/**
 * Signalements après validation (CDC 3.6 §3 et 3.7) : les éléments que le client a validés puis
 * qui ont été modifiés, regroupés par version, sans nouvelle validation formelle.
 */
export function NoticesPanel({ missionId, notices, canMarkSeen, onChanged }: Props) {
  const unseen = notices.filter((n) => n.seenAt === null);
  const versions = [...new Set(notices.map((n) => n.version))].sort((a, b) => b - a);

  async function markSeen(): Promise<void> {
    try {
      await endpoints.markNoticesSeen(
        missionId,
        unseen.map((n) => n.id),
      );
      showToast({ tone: 'success', title: t('validation.notices.markedSeen') });
      onChanged();
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }

  return (
    <section className="card stack" aria-labelledby="notices-title" data-testid="notices-panel">
      <div className="stack-sm">
        <h2 id="notices-title" className="h3">
          {t('validation.notices.heading')}
        </h2>
        <p className="muted">{t('validation.notices.intro')}</p>
      </div>
      {notices.length === 0 ? <p className="muted">{t('validation.notices.empty')}</p> : null}
      {unseen.length > 0 ? (
        <div className="row">
          <p role="status" data-testid="notices-unseen">
            {t('validation.notices.count', { count: unseen.length })}
          </p>
          {canMarkSeen ? (
            <Button variant="secondary" onPress={() => void markSeen()}>
              {t('validation.notices.markSeen')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {versions.map((version) => (
        <div key={version} className="notice-group stack-sm">
          <h3 className="h5">{t('validation.notices.version', { version })}</h3>
          <ul className="stack-sm" aria-label={t('validation.notices.listLabel')}>
            {notices
              .filter((n) => n.version === version)
              .map((notice) => (
                <li key={notice.id} data-testid="notice">
                  {notice.summary}{' '}
                  <span className="muted small">({formatDateTime(notice.createdAt)})</span>{' '}
                  <StatusBadge tone={notice.seenAt === null ? 'warning' : 'neutral'}>
                    {notice.seenAt === null
                      ? t('validation.notices.new')
                      : t('validation.notices.seen')}
                  </StatusBadge>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
