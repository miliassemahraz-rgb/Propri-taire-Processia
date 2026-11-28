'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CommentDto, SourceDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import type { BusinessModel, DiagramOutline } from '@processia/model';
import { Button, TextField, showToast } from '@processia/ui';
import { useMissionEvents } from '../../lib/collab';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { describeElement, indicatorValue, type ElementDetail } from '../../lib/mapping';
import { ElementStatusBadge } from '../analysis/element-status';
import { SourceViewer, type ViewerTarget } from '../analysis/source-viewer';
import { sourceTitle } from '../analysis/sources-section';
import { natureLabel } from './labels';

interface Props {
  missionId: string;
  model: BusinessModel;
  outline: DiagramOutline;
  /** Élément choisi ; à défaut, celui que détaille le niveau (processus, tâche…). */
  selectedId: string | null;
  canEdit: boolean;
  onOpen: (diagram: string) => void;
}

function List({ items }: { items: ReactNode[] }) {
  if (items.length === 0) return <>{t('cartography.viewer.panel.noValue')}</>;
  return (
    <ul className="plain">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="map-panel-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Comments({
  missionId,
  elementId,
  canEdit,
}: {
  missionId: string;
  elementId: string;
  canEdit: boolean;
}) {
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setComments(
        await endpoints.listComments(missionId, { targetKind: 'element', targetId: elementId }),
      );
    } catch {
      setComments([]);
    }
  }, [missionId, elementId]);

  useEffect(() => {
    void load();
  }, [load]);
  useMissionEvents((message) => {
    if (message.type === 'comment.created' && message.targetId === elementId) void load();
  });

  async function post(): Promise<void> {
    if (draft.trim() === '') return;
    setBusy(true);
    try {
      await endpoints.createComment(missionId, {
        targetKind: 'element',
        targetId: elementId,
        body: draft,
      });
      setDraft('');
      showToast({ tone: 'success', title: t('cartography.viewer.comments.sent') });
      await load();
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack-sm" aria-labelledby="map-comments" data-testid="element-comments">
      <h4 id="map-comments" className="h4">
        {t('cartography.viewer.comments.heading')}
      </h4>
      {comments.length === 0 ? (
        <p className="muted small">{t('cartography.viewer.comments.empty')}</p>
      ) : (
        <ul className="plain stack-sm">
          {comments.map((comment) => (
            <li key={comment.id} className="card-soft stack-sm" data-testid="element-comment">
              <p className="muted small">
                {t('cartography.viewer.comments.authorLine', {
                  name: comment.author.name,
                  date: formatDateTime(comment.createdAt),
                })}
                {' · '}
                {comment.submissionId === null
                  ? t('cartography.viewer.comments.internal')
                  : t('cartography.viewer.comments.shared')}
                {comment.resolvedAt !== null
                  ? ` · ${t('cartography.viewer.comments.resolved')}`
                  : ''}
              </p>
              <p className="comment-body">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="stack-sm">
          <TextField
            label={t('cartography.viewer.comments.label')}
            multiline
            value={draft}
            onChange={setDraft}
          />
          <div>
            <Button isDisabled={busy || draft.trim() === ''} onPress={() => void post()}>
              {t('cartography.viewer.comments.send')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Panneau de l'élément sélectionné (spécification 6.3) : nature, statut, responsable, entrées et
 * sorties, règles, indicateurs, constats, sources citées (avec la visionneuse de source) et
 * commentaires de l'équipe. Il suit la sélection des trois vues.
 */
export function ElementPanel({ missionId, model, outline, selectedId, canEdit, onOpen }: Props) {
  const detailId = selectedId ?? outline.anchorId ?? null;
  const detail: ElementDetail | null = useMemo(
    () => (detailId === null ? null : describeElement(model, detailId)),
    [model, detailId],
  );
  const node = outline.nodes.find((n) => n.id === detailId);
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);

  const hasSources = (detail?.sources.length ?? 0) > 0;
  useEffect(() => {
    if (!hasSources) return;
    let cancelled = false;
    void endpoints
      .listSources(missionId)
      .then((list) => {
        if (!cancelled) setSources(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [missionId, hasSources, detailId]);
  const titleOf = (sourceId: string): string => {
    const source = sources.find((s) => s.id === sourceId);
    return source === undefined ? sourceId : sourceTitle(source);
  };

  const heading = t('cartography.viewer.panel.heading');
  if (detail === null) {
    return (
      <aside
        className="map-panel stack-sm"
        aria-labelledby="map-panel-title"
        data-testid="element-panel"
      >
        <h3 id="map-panel-title" className="h3">
          {heading}
        </h3>
        <p className="muted">{t('cartography.viewer.panel.none')}</p>
      </aside>
    );
  }

  const element = model.elements[detail.id];
  const kind =
    node !== undefined
      ? natureLabel(node)
      : element?.kind === 'activity'
        ? t(`cartography.viewer.kind.${element.level}`)
        : t('cartography.viewer.kind.step');
  const drill = node?.drillTo;
  return (
    <aside
      className="map-panel stack-sm"
      aria-labelledby="map-panel-title"
      data-testid="element-panel"
      data-element-id={detail.id}
    >
      <h3 id="map-panel-title" className="h3">
        {heading}
      </h3>
      <p className="strong" data-testid="panel-label">
        <span className="mono">{detail.code}</span> {detail.label}
      </p>
      <div className="row">
        <ElementStatusBadge status={detail.status} />
        {drill !== undefined ? (
          <Button
            variant="secondary"
            aria-label={t('cartography.viewer.panel.openLabel', { label: detail.label })}
            onPress={() => onOpen(drill)}
            data-testid="panel-open"
          >
            {t('cartography.viewer.panel.open')}
          </Button>
        ) : null}
      </div>
      <dl className="map-panel-list">
        <Row label={t('cartography.viewer.panel.kind')}>{kind}</Row>
        <Row label={t('cartography.viewer.panel.origin')}>
          {t(`analysis.origin.${detail.origin as 'free_text'}`)}
        </Row>
        {detail.description !== undefined ? (
          <Row label={t('cartography.viewer.panel.description')}>{detail.description}</Row>
        ) : null}
        {detail.rationale !== undefined ? (
          <Row label={t('cartography.viewer.panel.rationale')}>{detail.rationale}</Row>
        ) : null}
        {detail.responsible !== undefined || detail.kind === 'activity' ? (
          <Row label={t('cartography.viewer.panel.responsible')}>
            {detail.responsible?.label ?? t('cartography.viewer.panel.noValue')}
          </Row>
        ) : null}
        {detail.raci.length > 0 ? (
          <Row label={t('cartography.viewer.panel.raci')}>
            <List
              items={detail.raci.map(
                (r) => `${r.actor.label} (${t(`cartography.viewer.panel.role.${r.role as 'R'}`)})`,
              )}
            />
          </Row>
        ) : null}
        {detail.kind === 'activity' ? (
          <>
            <Row label={t('cartography.viewer.panel.inputs')}>
              <List items={detail.inputs.map((i) => i.label)} />
            </Row>
            <Row label={t('cartography.viewer.panel.outputs')}>
              <List items={detail.outputs.map((i) => i.label)} />
            </Row>
            {detail.tools.length > 0 ? (
              <Row label={t('cartography.viewer.panel.tools')}>
                <List items={detail.tools.map((i) => i.label)} />
              </Row>
            ) : null}
          </>
        ) : null}
        {detail.trigger !== undefined ? (
          <Row label={t('cartography.viewer.panel.trigger')}>{detail.trigger}</Row>
        ) : null}
        {detail.timer !== undefined ? (
          <Row label={t('cartography.viewer.panel.timer')}>{detail.timer}</Row>
        ) : null}
        {detail.fields.length > 0 ? (
          <Row label={t('cartography.viewer.panel.fields')}>
            <List items={detail.fields.map((f) => `${f.name} (${f.type})`)} />
          </Row>
        ) : null}
        <Row label={t('cartography.viewer.panel.rules')}>
          <List
            items={detail.rules.map((r) => (
              <span key={r.id}>
                <span className="mono">{r.code}</span> {r.text}
              </span>
            ))}
          />
        </Row>
        <Row label={t('cartography.viewer.panel.indicators')}>
          <List
            items={detail.indicators.map(
              (i) =>
                `${t(`cartography.viewer.panel.measure.${i.measure as 'volume'}`)} : ${indicatorValue(i.value, i.unit)}`,
            )}
          />
        </Row>
        {detail.findings.length > 0 ? (
          <Row label={t('cartography.viewer.panel.findings')}>
            <List
              items={detail.findings.map(
                (f) =>
                  `${f.label} (${t('cartography.viewer.panel.severity', { level: f.severity })})`,
              )}
            />
          </Row>
        ) : null}
      </dl>
      <section className="stack-sm" aria-labelledby="map-sources">
        <h4 id="map-sources" className="h4">
          {t('cartography.viewer.panel.sources')}
        </h4>
        {detail.sources.length === 0 ? (
          <p className="muted small">{t('analysis.fiche.noCitation')}</p>
        ) : (
          <ul className="plain stack-sm">
            {detail.sources.map((reference, index) => (
              <li key={`${reference.sourceId}-${index}`} className="citation">
                <blockquote className="citation-quote">{reference.quote}</blockquote>
                <p className="muted small">{titleOf(reference.sourceId)}</p>
                <Button
                  variant="secondary"
                  aria-label={t('cartography.viewer.panel.openSourceLabel', {
                    quote: reference.quote,
                  })}
                  onPress={() =>
                    setViewer({
                      sourceId: reference.sourceId,
                      title: titleOf(reference.sourceId),
                      chunkId: reference.chunkId,
                      charStart: reference.locator.charStart,
                      charEnd: reference.locator.charEnd,
                    })
                  }
                >
                  {t('cartography.viewer.panel.openSource')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Comments key={detail.id} missionId={missionId} elementId={detail.id} canEdit={canEdit} />
      <SourceViewer missionId={missionId} target={viewer} onClose={() => setViewer(null)} />
    </aside>
  );
}
