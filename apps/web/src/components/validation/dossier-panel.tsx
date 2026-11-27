'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type {
  CommentDto,
  CommentTargetKind,
  DeliverablesPreviewDto,
  ExportFormat,
  SubmissionDto,
  SubmissionElementDto,
} from '@processia/contracts';
import { t } from '@processia/i18n';
import type { ElementKind, ElementStatus } from '@processia/model';
import { Button, DataTable, Dialog, Notice, Tabs, TextField, showToast } from '@processia/ui';
import { EXPORT_FORMATS_ORDER, shortSha } from '../../lib/deliverables';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatLongDate } from '../../lib/format';
import { useMode } from '../../lib/mode';
import { commentCount } from '../../lib/validation';
import { ElementStatusBadge } from '../analysis/element-status';
import { DocumentView } from '../deliverables/document-view';
import { CommentThread } from './comment-thread';

/** Ce que reçoit le panneau d'une soumission (le portail le choisit par type : voir `PANELS`). */
export interface PanelProps {
  missionId: string;
  submission: SubmissionDto;
  comments: CommentDto[];
  isValidator: boolean;
  /** Le compte peut commenter (droit `comment.create`, soumission en cours ou validée). */
  canComment: boolean;
  /** Recharge soumissions, commentaires et signalements. */
  onChanged: () => void;
  /** Soumission la plus récente du même type (pour proposer de la consulter). */
  latestId: string | null;
  onSelect: (submissionId: string) => void;
}

const ELEMENT: CommentTargetKind = 'element';
const DELIVERABLE: CommentTargetKind = 'deliverable';
const SUBMISSION: CommentTargetKind = 'submission';
const TAB = {
  document: 'document',
  elements: 'elements',
  exports: 'exports',
  discussion: 'discussion',
} as const;

type DetailState<T> =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

/** Charge une ressource de la version figée ; recharge si la soumission change. */
function useFrozen<T>(
  submissionId: string,
  load: () => Promise<T>,
  deps: readonly unknown[],
): DetailState<T> {
  const [state, setState] = useState<DetailState<T>>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    load().then(
      (value) => {
        if (!cancelled) setState({ status: 'ready', value });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` change à chaque rendu : seules les dépendances explicites relancent la lecture.
  }, [submissionId, ...deps]);
  return state;
}

function startDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

function Loading<T>({
  state,
  children,
}: {
  state: DetailState<T>;
  children: (value: T) => React.ReactNode;
}) {
  if (state.status === 'loading') return <p role="status">{t('validation.loading')}</p>;
  if (state.status === 'error') {
    return (
      <Notice tone="danger" role="alert">
        {state.message}
      </Notice>
    );
  }
  return <>{children(state.value)}</>;
}

function ElementsTab({
  missionId,
  submission,
  comments,
  canComment,
  onChanged,
}: Pick<PanelProps, 'missionId' | 'submission' | 'comments' | 'canComment' | 'onChanged'>) {
  const state = useFrozen(
    submission.id,
    () => endpoints.submissionElements(missionId, submission.id),
    [missionId],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Loading state={state}>
      {(elements: SubmissionElementDto[]) => (
        <div className="stack">
          <p className="muted">{t('validation.elements.intro')}</p>
          {elements.length === 0 ? (
            <p className="muted">{t('validation.elements.empty')}</p>
          ) : (
            <DataTable caption={t('validation.elements.caption')}>
              <thead>
                <tr>
                  <th scope="col">{t('validation.elements.columns.code')}</th>
                  <th scope="col">{t('validation.elements.columns.label')}</th>
                  <th scope="col">{t('validation.elements.columns.kind')}</th>
                  <th scope="col">{t('validation.elements.columns.status')}</th>
                  <th scope="col">{t('validation.elements.columns.comments')}</th>
                </tr>
              </thead>
              <tbody>
                {elements.map((element) => {
                  const count = commentCount(comments, submission.id, ELEMENT, element.id);
                  return (
                    <tr key={element.id} data-testid="element-row">
                      <th scope="row">{element.code}</th>
                      <td>{element.label}</td>
                      <td>{t(`analysis.kind.${element.kind as ElementKind}`)}</td>
                      <td>
                        <ElementStatusBadge status={element.status as ElementStatus} />
                      </td>
                      <td>
                        <Button
                          variant="secondary"
                          aria-expanded={openId === element.id}
                          aria-label={t('validation.comments.toggleLabel', {
                            name: `${element.code} ${element.label}`,
                            count,
                          })}
                          onPress={() => setOpenId(openId === element.id ? null : element.id)}
                        >
                          {t('validation.comments.toggle', { count })}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
          {openId !== null ? (
            <CommentThread
              missionId={missionId}
              submission={submission}
              targetKind={ELEMENT}
              targetId={openId}
              title={t('validation.comments.forElement', {
                code: elements.find((e) => e.id === openId)?.code ?? '',
              })}
              comments={comments}
              canComment={canComment}
              onChanged={onChanged}
            />
          ) : null}
        </div>
      )}
    </Loading>
  );
}

function ExportsTab({
  missionId,
  submission,
  isValidator,
  onChanged,
}: Pick<PanelProps, 'missionId' | 'submission' | 'isValidator' | 'onChanged'>) {
  const { mode } = useMode();
  const have = new Set(submission.exports.map((file) => file.format));
  const missing = EXPORT_FORMATS_ORDER.filter((format) => !have.has(format));

  async function download(artifactId: string): Promise<void> {
    try {
      const link = await endpoints.submissionDownloadUrl(missionId, submission.id, artifactId);
      startDownload(link.url, link.filename);
    } catch (error) {
      showToast({
        tone: 'error',
        title: t('validation.exports.downloadFailed'),
        description: errorMessage(error),
      });
    }
  }

  async function retry(format: ExportFormat): Promise<void> {
    try {
      await endpoints.startSubmissionExport(missionId, submission.id, format);
      showToast({
        tone: 'success',
        title: t('validation.team.exportStarted', {
          format: t(`deliverables.export.formats.${format}`),
        }),
      });
      onChanged();
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }

  return (
    <div className="stack">
      <p className="muted">{t('validation.exports.help')}</p>
      {submission.exports.length === 0 ? (
        <p role="status">{t('validation.exports.empty')}</p>
      ) : (
        <DataTable caption={t('validation.exports.heading')}>
          <thead>
            <tr>
              <th scope="col">{t('validation.exports.columns.format')}</th>
              <th scope="col">{t('validation.exports.columns.file')}</th>
              <th scope="col">{t('validation.exports.columns.sha')}</th>
              <th scope="col">{t('validation.exports.columns.action')}</th>
            </tr>
          </thead>
          <tbody>
            {submission.exports.map((file) => (
              <tr key={file.id} data-testid="submission-export">
                <th scope="row">{t(`deliverables.export.formats.${file.format}`)}</th>
                <td>{file.filename}</td>
                <td className="mono">{mode === 'expert' ? file.sha256 : shortSha(file.sha256)}</td>
                <td>
                  <Button
                    variant="secondary"
                    aria-label={t('validation.exports.downloadLabel', { filename: file.filename })}
                    onPress={() => void download(file.id)}
                  >
                    {t('validation.exports.download')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {!isValidator &&
      missing.length > 0 &&
      submission.status !== 'withdrawn' &&
      submission.exports.length > 0 ? (
        <div className="row">
          {missing.map((format) => (
            <Button key={format} variant="secondary" onPress={() => void retry(format)}>
              {t('validation.team.retryExport', {
                format: t(`deliverables.export.formats.${format}`),
              })}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ValidateAction({
  missionId,
  submission,
  onChanged,
}: Pick<PanelProps, 'missionId' | 'submission' | 'onChanged'>) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      const result = await endpoints.validateSubmission(missionId, submission.id, comment.trim());
      showToast({
        tone: 'success',
        title: t('validation.validate.done', { count: result.validatedCount }),
      });
      if (result.skippedChangedIds.length > 0) {
        showToast({
          tone: 'info',
          title: t('validation.validate.skipped', { count: result.skippedChangedIds.length }),
        });
      }
      setOpen(false);
      onChanged();
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onPress={() => setOpen(true)}>{t('validation.validate.button')}</Button>
      <Dialog title={t('validation.validate.title')} isOpen={open} onOpenChange={setOpen}>
        <div className="stack" data-testid="validate-dialog">
          <p>{t('validation.validate.body', { version: submission.modelVersion })}</p>
          <TextField
            label={t('validation.validate.comment')}
            multiline
            value={comment}
            onChange={setComment}
          />
          <div className="row end">
            <Button variant="secondary" onPress={() => setOpen(false)}>
              {t('ui.cancel')}
            </Button>
            <Button isDisabled={busy} onPress={() => void confirm()}>
              {t('validation.validate.confirm')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function TeamActions({
  missionId,
  submission,
  onChanged,
}: Pick<PanelProps, 'missionId' | 'submission' | 'onChanged'>) {
  const [busy, setBusy] = useState(false);
  async function withdraw(): Promise<void> {
    setBusy(true);
    try {
      await endpoints.withdrawSubmission(missionId, submission.id);
      showToast({ tone: 'success', title: t('validation.team.withdrawn') });
      onChanged();
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack-sm">
      <div className="row">
        {submission.status === 'submitted' ? (
          <Button variant="secondary" isDisabled={busy} onPress={() => void withdraw()}>
            {t('validation.team.withdraw')}
          </Button>
        ) : null}
        <Link href={`/missions/${missionId}/analyse`} className="pr-button pr-button--secondary">
          {t('validation.team.goAnalysis')}
        </Link>
      </div>
      {submission.status === 'submitted' ? (
        <p className="muted small">{t('validation.team.withdrawHelp')}</p>
      ) : null}
    </div>
  );
}

/**
 * Soumission du dossier d'analyse : lecture seule de la version figée (livrables, éléments),
 * fichiers joints, discussion, et la décision du validateur. Les panneaux de l'AS-IS et du TO-BE
 * (WP-21, WP-23) se branchent de la même façon dans `PANELS`.
 */
export function DossierPanel(props: PanelProps) {
  const {
    missionId,
    submission,
    comments,
    isValidator,
    canComment,
    onChanged,
    latestId,
    onSelect,
  } = props;
  const document = useFrozen<DeliverablesPreviewDto>(
    submission.id,
    () => endpoints.submissionDocument(missionId, submission.id),
    [missionId],
  );

  return (
    <div className="stack-lg" data-testid="dossier-panel" data-status={submission.status}>
      <section className="stack-sm" aria-labelledby="submission-title">
        <h2 id="submission-title" className="h3" data-testid="submission-title">
          {t('validation.submissions.round', { round: submission.round })}
        </h2>
        <p className="muted" data-testid="submission-summary">
          {t('validation.submissions.summary', {
            version: submission.modelVersion,
            date: formatDateTime(submission.submittedAt),
            name: submission.submittedBy.name,
          })}
        </p>
        {submission.comment !== null && submission.status !== 'validated' ? (
          <p className="small">{t('validation.submissions.note', { note: submission.comment })}</p>
        ) : null}
        <div data-testid="frozen-notice">
          <Notice tone="info">
            {t('validation.frozenNotice', { version: submission.modelVersion })}
          </Notice>
        </div>
        {submission.status === 'validated' && submission.decidedAt !== null ? (
          <div data-testid="validated-banner">
            <Notice tone="success">
              {t('validation.validatedBanner', {
                date: formatLongDate(submission.decidedAt),
                name: submission.decidedBy?.name ?? '',
              })}
              {submission.comment !== null
                ? ` ${t('validation.validatedComment', { comment: submission.comment })}`
                : ''}
            </Notice>
          </div>
        ) : null}
        {submission.status === 'superseded' ? (
          <div data-testid="superseded-banner">
            <Notice tone="warning">
              {t('validation.supersededBanner')}{' '}
              {latestId !== null && latestId !== submission.id ? (
                <Button variant="quiet" onPress={() => onSelect(latestId)}>
                  {t('validation.supersededLink')}
                </Button>
              ) : null}
            </Notice>
          </div>
        ) : null}
        {isValidator && submission.status === 'submitted' ? (
          <div className="stack-sm">
            <div className="row">
              <ValidateAction missionId={missionId} submission={submission} onChanged={onChanged} />
            </div>
            <p className="muted small">{t('validation.validate.noRefuse')}</p>
          </div>
        ) : null}
        {!isValidator ? (
          <TeamActions missionId={missionId} submission={submission} onChanged={onChanged} />
        ) : null}
      </section>

      {!isValidator ? (
        <section className="card-soft stack-sm" aria-labelledby="excluded-title">
          <h3 id="excluded-title" className="h5">
            {t('validation.team.excludedHeading')} ({submission.excludedCount})
          </h3>
          {submission.excludedCount === 0 ? (
            <p className="muted small">{t('validation.team.excludedNone')}</p>
          ) : (
            <>
              <p className="muted small">{t('validation.team.excludedIntro')}</p>
              <ul className="stack-sm" data-testid="excluded-list">
                {(submission.excludedHypotheses ?? []).map((hypothesis) => (
                  <li key={hypothesis.id}>
                    <span className="strong">{hypothesis.code}</span> {hypothesis.label}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}

      <Tabs
        label={t('validation.tabs.label')}
        items={[
          {
            id: TAB.document,
            label: t('validation.tabs.document'),
            content: (
              <Loading state={document}>
                {(preview: DeliverablesPreviewDto) => (
                  <DocumentView
                    document={preview.document}
                    sectionExtra={(section) => (
                      <details className="comment-details">
                        <summary>
                          {t('validation.comments.toggleLabel', {
                            name: section.title,
                            count: commentCount(comments, submission.id, DELIVERABLE, section.id),
                          })}
                        </summary>
                        <CommentThread
                          missionId={missionId}
                          submission={submission}
                          targetKind={DELIVERABLE}
                          targetId={section.id}
                          title={t('validation.comments.forDeliverable', { title: section.title })}
                          comments={comments}
                          canComment={canComment}
                          onChanged={onChanged}
                        />
                      </details>
                    )}
                  />
                )}
              </Loading>
            ),
          },
          {
            id: TAB.elements,
            label: t('validation.tabs.elements'),
            content: (
              <ElementsTab
                missionId={missionId}
                submission={submission}
                comments={comments}
                canComment={canComment}
                onChanged={onChanged}
              />
            ),
          },
          {
            id: TAB.exports,
            label: t('validation.tabs.exports'),
            content: (
              <ExportsTab
                missionId={missionId}
                submission={submission}
                isValidator={isValidator}
                onChanged={onChanged}
              />
            ),
          },
          {
            id: TAB.discussion,
            label: t('validation.tabs.discussion'),
            content: (
              <CommentThread
                missionId={missionId}
                submission={submission}
                targetKind={SUBMISSION}
                targetId={submission.id}
                title={t('validation.comments.forSubmission')}
                comments={comments}
                canComment={canComment}
                onChanged={onChanged}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
