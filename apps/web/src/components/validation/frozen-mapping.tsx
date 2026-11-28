'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CommentTargetKind, SubmissionMappingDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import { buildOutline, diagramTrail, type DiagramOutline } from '@processia/model';
import { Notice } from '@processia/ui';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';
import { markersByElement, stepLabel } from '../../lib/mapping';
import { SimpleView } from '../mapping/simple-view';
import { TextView } from '../mapping/text-view';
import { CommentThread } from './comment-thread';
import type { PanelProps } from './dossier-panel';

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; mapping: SubmissionMappingDto };

type View = 'simple' | 'text';
const VIEWS: View[] = ['simple', 'text'];
const ROOT = 'L0';
const ELEMENT: CommentTargetKind = 'element';

function titleOf(outline: DiagramOutline): string {
  return outline.anchorCode === undefined
    ? t('cartography.viewer.titleGlobal')
    : t('cartography.viewer.titleLevel', {
        code: outline.anchorCode,
        label: outline.anchorLabel ?? '',
      });
}

/**
 * Cartographie en lecture seule de la version figée d'un AS-IS (WP-21) : fil d'Ariane L0 à L3, vue
 * simplifiée et alternative textuelle, sans BPMN complet (le validateur n'a pas accès à la tête du
 * modèle) ni dialogue. Le validateur choisit une étape et la commente ; le fil de discussion
 * s'attache à l'élément de la version figée.
 */
export function FrozenMapping({
  missionId,
  submission,
  comments,
  canComment,
  onChanged,
}: Pick<PanelProps, 'missionId' | 'submission' | 'comments' | 'canComment' | 'onChanged'>) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [diagram, setDiagram] = useState(ROOT);
  const [view, setView] = useState<View>('simple');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: 'loading' });
    endpoints.submissionMapping(missionId, submission.id).then(
      (mapping) => {
        if (!cancelled) setLoaded({ status: 'ready', mapping });
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'error', message: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [missionId, submission.id]);

  const model = loaded.status === 'ready' ? loaded.mapping.model : null;
  const outline = useMemo(
    () => (model === null ? undefined : buildOutline(model, diagram)),
    [model, diagram],
  );
  const markers = useMemo(() => (model === null ? new Map() : markersByElement(model)), [model]);
  const trail = useMemo(
    () => (model === null ? [] : diagramTrail(model, diagram)),
    [model, diagram],
  );

  if (loaded.status === 'loading') return <p role="status">{t('validation.mapping.loading')}</p>;
  if (loaded.status === 'error') {
    return (
      <Notice tone="danger" role="alert">
        {loaded.message}
      </Notice>
    );
  }
  if (model === null || outline === undefined) {
    return <Notice tone="info">{t('validation.mapping.empty')}</Notice>;
  }

  const open = (next: string): void => {
    setDiagram(next);
    setSelectedId(null);
  };
  const selected = selectedId === null ? undefined : model.elements[selectedId];
  const node = selectedId === null ? undefined : outline.nodes.find((n) => n.id === selectedId);
  const macros = Object.values(model.elements).filter(
    (e) => e.kind === 'activity' && e.level === 'macro',
  ).length;
  if (macros === 0) return <Notice tone="info">{t('validation.mapping.empty')}</Notice>;

  return (
    <div className="stack" data-testid="frozen-mapping" data-diagram={diagram}>
      <p className="muted">{t('validation.mapping.intro')}</p>
      <nav aria-label={t('cartography.viewer.breadcrumb')} className="map-breadcrumb">
        <ol className="plain row">
          {trail.map((id, index) => {
            const item = buildOutline(model, id);
            const last = index === trail.length - 1;
            const label =
              item === undefined
                ? id
                : item.anchorCode === undefined
                  ? t('cartography.viewer.level0', { count: macros })
                  : t('cartography.viewer.crumb', {
                      code: item.anchorCode,
                      label: item.anchorLabel ?? '',
                    });
            return (
              <li key={id} className="row">
                {last ? (
                  <span aria-current="page" className="strong">
                    {label}
                  </span>
                ) : (
                  <>
                    <button type="button" className="map-link" onClick={() => open(id)}>
                      {label}
                    </button>
                    <span aria-hidden="true">›</span>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="page-head">
        <h3 className="h3" data-testid="frozen-diagram-title">
          {titleOf(outline)}
        </h3>
        <div role="group" aria-label={t('cartography.viewer.views.label')} className="map-views">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              className="map-view-button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              data-testid={`frozen-view-${v}`}
            >
              {t(`cartography.viewer.views.${v}`)}
            </button>
          ))}
        </div>
      </div>
      {view === 'simple' ? (
        <SimpleView
          outline={outline}
          title={titleOf(outline)}
          markers={markers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpen={open}
        />
      ) : (
        <TextView
          model={model}
          outline={outline}
          title={titleOf(outline)}
          markers={markers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpen={open}
        />
      )}
      {selected !== undefined && node !== undefined ? (
        <CommentThread
          missionId={missionId}
          submission={submission}
          targetKind={ELEMENT}
          targetId={selected.id}
          title={t('validation.mapping.commentFor', { code: stepLabel(node) })}
          comments={comments}
          canComment={canComment}
          onChanged={onChanged}
        />
      ) : (
        <p className="muted small">{t('validation.mapping.selectHint')}</p>
      )}
    </div>
  );
}
