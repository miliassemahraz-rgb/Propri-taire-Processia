'use client';

import { useRef, useState } from 'react';
import type { SourceDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import type { BusinessModel } from '@processia/model';
import { Button, StatusBadge, showToast, type BadgeTone } from '@processia/ui';
import { citationCountBySource, isAnalyzable, openDiscrepancies } from '../../lib/analysis';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';
import type { ViewerTarget } from './source-viewer';

const ACCEPT = '.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.txt,.md';

const STATUS_TONE: Record<SourceDto['textStatus'], BadgeTone> = {
  pending: 'neutral',
  extracted: 'success',
  unreadable: 'warning',
  failed: 'danger',
};

export function sourceTitle(source: Pick<SourceDto, 'kind' | 'title' | 'revision'>): string {
  return source.kind === 'free_text'
    ? t('analysis.sources.descriptionTitle', { revision: source.revision })
    : source.title;
}

interface Props {
  missionId: string;
  sources: SourceDto[] | null;
  model: BusinessModel | null;
  canEdit: boolean;
  busy: boolean;
  onAnalyze: (sourceId: string) => void;
  onUploaded: () => void;
  onOpen: (target: ViewerTarget) => void;
  onSeeDiscrepancies: () => void;
}

/** Sources de la mission : dépôt de documents, état de lecture, éléments extraits, contradictions. */
export function SourcesSection({
  missionId,
  sources,
  model,
  canEdit,
  busy,
  onAnalyze,
  onUploaded,
  onOpen,
  onSeeDiscrepancies,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const counts = citationCountBySource(model);
  const gaps = openDiscrepancies(model);
  const firstGap = gaps[0];

  async function upload(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) return;
    setUploading(true);
    for (const file of Array.from(files)) {
      try {
        await endpoints.uploadDocument(missionId, file);
        showToast({
          tone: 'success',
          title: t('analysis.sources.uploaded'),
          description: t('analysis.sources.uploadedDetail', { name: file.name }),
        });
      } catch (error) {
        showToast({
          tone: 'error',
          title: t('analysis.sources.uploadFailed', { name: file.name }),
          description: errorMessage(error),
        });
      }
    }
    setUploading(false);
    if (input.current !== null) input.current.value = '';
    onUploaded();
  }

  return (
    <section aria-labelledby="analysis-sources" className="card stack">
      <h2 id="analysis-sources" className="h3">
        {t('analysis.sources.heading')}
      </h2>
      {sources === null ? <p role="status">{t('ui.loading')}</p> : null}
      {sources !== null && sources.length === 0 ? (
        <p className="muted">{t('analysis.sources.empty')}</p>
      ) : null}
      {sources !== null && sources.length > 0 ? (
        <ul className="plain stack source-list" aria-label={t('analysis.sources.list')}>
          {sources.map((source) => {
            const title = sourceTitle(source);
            const count = counts.get(source.id) ?? 0;
            return (
              <li key={source.id} className="source-item" data-testid="source-item">
                <div className="row source-head">
                  <span className="strong">{title}</span>
                  <StatusBadge tone={STATUS_TONE[source.textStatus]}>
                    {t(`analysis.sources.status.${source.textStatus}`)}
                  </StatusBadge>
                </div>
                <p className="muted small">
                  {count > 0
                    ? t('analysis.sources.elementCount', { count })
                    : t('analysis.sources.noElement')}
                </p>
                {isAnalyzable(source) ? (
                  <div className="row">
                    <Button
                      variant="quiet"
                      aria-label={t('analysis.sources.openLabel', { title })}
                      onPress={() => onOpen({ sourceId: source.id, title, ordinal: 0 })}
                    >
                      {t('analysis.sources.open')}
                    </Button>
                    {canEdit && source.kind === 'document' ? (
                      <Button
                        variant="secondary"
                        isDisabled={busy}
                        aria-label={t('analysis.sources.analyzeSourceLabel', { title })}
                        onPress={() => onAnalyze(source.id)}
                      >
                        {t('analysis.sources.analyzeSource')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {canEdit ? (
        <div className="stack">
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            aria-label={t('analysis.sources.uploadLabel')}
            data-testid="source-upload"
            onChange={(event) => void upload(event.target.files)}
          />
          <Button variant="secondary" isDisabled={uploading} onPress={() => input.current?.click()}>
            {t('analysis.sources.upload')}
          </Button>
          <p className="muted small">{t('analysis.sources.uploadHelp')}</p>
        </div>
      ) : null}

      {firstGap !== undefined ? (
        <div role="note" className="pr-notice pr-notice--warning" data-testid="contradiction">
          <strong className="pr-notice-title">{t('analysis.contradiction.title')}</strong>
          <div className="stack">
            <p>
              {t('analysis.contradiction.claims', {
                first: firstGap.sides[0]?.claim ?? '',
                second: firstGap.sides[1]?.claim ?? '',
              })}
            </p>
            {gaps.length > 1 ? (
              <p className="small">
                {t('analysis.contradiction.more', { count: gaps.length - 1 })}
              </p>
            ) : null}
            <div>
              <Button variant="secondary" onPress={onSeeDiscrepancies}>
                {t('analysis.contradiction.see')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
