'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { DeliverablesPreviewDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import { Notice } from '@processia/ui';
import { useMissionModel } from '../lib/collab';
import { deliverableAnchor, pendingHypothesisCount } from '../lib/deliverables';
import { endpoints } from '../lib/endpoints';
import { errorMessage } from '../lib/errors';
import { DocumentView } from './deliverables/document-view';
import { ExportPanel } from './deliverables/export-panel';
import { useMission } from './mission-frame';

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preview: DeliverablesPreviewDto };

/**
 * Page « Livrables » (WP-15) : aperçu HTML des 4 livrables de l'étape 1 (fiche métier et
 * glossaire, acteurs et matrice RACI, dictionnaire de données et flux, registre des règles) et
 * exports Word, PDF et Excel. L'aperçu est celui du serveur (`deliverableView` : aucune
 * hypothèse) ; il se recharge quand une nouvelle version du modèle est enregistrée.
 */
export function DeliverablesPage() {
  const mission = useMission();
  const missionId = mission.id;
  const model = useMissionModel();
  const headVersion = model?.version ?? null;
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const isValidator = mission.myRole === 'validator';

  useEffect(() => {
    if (isValidator) return;
    let cancelled = false;
    (async () => {
      try {
        const preview = await endpoints.deliverables(missionId);
        if (!cancelled) setLoaded({ status: 'ready', preview });
      } catch (error) {
        if (!cancelled) setLoaded({ status: 'error', message: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missionId, headVersion, isValidator]);

  if (isValidator) {
    return (
      <div className="stack-lg">
        <h1>{t('deliverables.heading')}</h1>
        <Notice tone="info">{t('deliverables.validatorNotice')}</Notice>
      </div>
    );
  }

  const pending = pendingHypothesisCount(model);
  const preview = loaded.status === 'ready' ? loaded.preview : null;

  return (
    <div className="stack-lg deliverables">
      <div className="page-head">
        <div className="stack-sm">
          <h1>{t('deliverables.heading')}</h1>
          <p className="muted">{t('deliverables.intro')}</p>
          {preview !== null ? (
            <p className="muted small" data-testid="deliverables-version">
              {t('deliverables.version', { version: preview.version })}
            </p>
          ) : null}
        </div>
        <Link href={`/missions/${missionId}/analyse`} className="pr-button pr-button--secondary">
          {t('deliverables.backToAnalysis')}
        </Link>
      </div>

      {pending > 0 ? (
        <Notice tone="info">
          {t('deliverables.pending', { count: pending })}{' '}
          <Link href={`/missions/${missionId}/analyse#hypotheses`}>
            {t('deliverables.pendingLink')}
          </Link>
        </Notice>
      ) : null}

      {loaded.status === 'loading' ? <p role="status">{t('deliverables.loading')}</p> : null}
      {loaded.status === 'error' ? (
        <Notice tone="danger" role="alert">
          {loaded.message}
        </Notice>
      ) : null}

      {preview !== null ? (
        <>
          <section aria-labelledby="deliverables-notices" className="stack-sm">
            <h2 id="deliverables-notices" className="h4">
              {t('deliverables.notices')}
            </h2>
            <ul className="stack-sm muted small">
              {preview.document.notices.map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
          </section>
          <nav aria-label={t('deliverables.sectionsNav')}>
            <ul className="row plain">
              {preview.document.deliverables.map((section) => (
                <li key={section.id}>
                  <a href={`#${deliverableAnchor(section.id)}`}>{section.title}</a>
                </li>
              ))}
            </ul>
          </nav>
        </>
      ) : null}

      <ExportPanel missionId={missionId} version={preview?.version ?? null} />

      {preview !== null ? <DocumentView document={preview.document} /> : null}
    </div>
  );
}
