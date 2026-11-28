'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@processia/i18n';
import {
  buildOutline,
  diagramTrail,
  type BusinessModel,
  type DiagramOutline,
} from '@processia/model';
import { Notice } from '@processia/ui';
import { useMode } from '../../lib/mode';
import { markersByElement, stepLabel } from '../../lib/mapping';
import { BpmnView } from './bpmn-view';
import { ElementPanel } from './element-panel';
import { SimpleView } from './simple-view';
import { TextView } from './text-view';

export type MappingView = 'simple' | 'bpmn' | 'text';

const VIEWS: MappingView[] = ['simple', 'bpmn', 'text'];
const ROOT = 'L0';
const TEXT_VIEW: MappingView = 'text';

interface Props {
  missionId: string;
  model: BusinessModel;
  canEdit: boolean;
}

function titleOf(outline: DiagramOutline): string {
  return outline.anchorCode === undefined
    ? t('cartography.viewer.titleGlobal')
    : t('cartography.viewer.titleLevel', {
        code: outline.anchorCode,
        label: outline.anchorLabel ?? '',
      });
}

/**
 * Visionneuse de la cartographie (WP-19, spécification 6.3) : le niveau choisi (L0 à L3) en vue
 * simplifiée, en BPMN complet ou en alternative textuelle, avec le fil d'Ariane des niveaux, le
 * panneau de l'élément sélectionné et les marqueurs. Elle lit le modèle partagé : toute version
 * enregistrée, par soi ou par un autre consultant, met les trois vues à jour.
 */
export function MappingViewer({ missionId, model, canEdit }: Props) {
  const { mode } = useMode();
  const [diagram, setDiagram] = useState<string>(ROOT);
  const [view, setView] = useState<MappingView>(mode === 'expert' ? 'bpmn' : 'simple');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const firstRender = useRef(true);

  // Le mode choisi dans l'en-tête fixe la vue de départ ; un choix local la remplace ensuite.
  const modeSeen = useRef(mode);
  useEffect(() => {
    if (modeSeen.current !== mode) {
      modeSeen.current = mode;
      setView(mode === 'expert' ? 'bpmn' : 'simple');
    }
  }, [mode]);

  const outline = useMemo(() => buildOutline(model, diagram), [model, diagram]);
  const markers = useMemo(() => markersByElement(model), [model]);
  const trail = useMemo(() => diagramTrail(model, diagram), [model, diagram]);
  const macroCount = useMemo(
    () =>
      Object.values(model.elements).filter((e) => e.kind === 'activity' && e.level === 'macro')
        .length,
    [model],
  );

  // Un niveau qui disparaît (retour arrière, rejet) ramène à la cartographie globale.
  const missing = outline === undefined;
  useEffect(() => {
    if (missing && diagram !== ROOT) setDiagram(ROOT);
  }, [missing, diagram]);

  // Une sélection dont l'élément a disparu est abandonnée.
  useEffect(() => {
    if (selectedId !== null && model.elements[selectedId] === undefined) setSelectedId(null);
  }, [model, selectedId]);

  // Après une descente ou une remontée, le focus va au titre du niveau.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [diagram]);

  function open(next: string): void {
    setDiagram(next);
    setSelectedId(null);
    const target = buildOutline(model, next);
    if (target !== undefined) {
      setAnnouncement(t('cartography.viewer.announce.opened', { title: titleOf(target) }));
    }
  }

  function select(id: string): void {
    setSelectedId(id);
    const node = outline?.nodes.find((n) => n.id === id);
    if (node !== undefined) {
      setAnnouncement(t('cartography.viewer.announce.selected', { step: stepLabel(node) }));
    }
  }

  if (macroCount === 0) {
    return (
      <Notice tone="info" role="status">
        {t('cartography.viewer.empty')}
      </Notice>
    );
  }
  if (outline === undefined) {
    return (
      <Notice tone="info" role="status">
        {t('cartography.viewer.unknownDiagram')}
      </Notice>
    );
  }

  const title = titleOf(outline);
  const parent = trail.length >= 2 ? (trail[trail.length - 2] as string) : null;

  return (
    <div className="stack" data-testid="mapping-viewer" data-diagram={diagram}>
      <nav aria-label={t('cartography.viewer.breadcrumb')} className="map-breadcrumb">
        <ol className="plain row">
          {trail.map((id, index) => {
            const item = buildOutline(model, id);
            const last = index === trail.length - 1;
            const label =
              item === undefined
                ? id
                : item.anchorCode === undefined
                  ? t('cartography.viewer.level0', { count: macroCount })
                  : last
                    ? t('cartography.viewer.crumbCurrent', {
                        code: item.anchorCode,
                        label: item.anchorLabel ?? '',
                        level: id.slice(1, 2),
                      })
                    : t('cartography.viewer.crumb', {
                        code: item.anchorCode,
                        label: item.anchorLabel ?? '',
                      });
            return (
              <li key={id} className="row">
                {last ? (
                  <span aria-current="page" className="strong" data-testid="crumb-current">
                    {label}
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="map-link"
                      onClick={() => open(id)}
                      data-testid="crumb"
                    >
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
        <h2 ref={headingRef} tabIndex={-1} className="h2" data-testid="diagram-title">
          {title}
        </h2>
        <div className="row">
          {parent !== null ? (
            <button
              type="button"
              className="pr-button pr-button--secondary"
              onClick={() => open(parent)}
              data-testid="level-up"
            >
              {t('cartography.viewer.up')}
            </button>
          ) : null}
          <div role="group" aria-label={t('cartography.viewer.views.label')} className="map-views">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                className="map-view-button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                data-testid={`view-${v}`}
              >
                {t(`cartography.viewer.views.${v}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="muted small" data-testid="legend">
        {t('cartography.viewer.legend.heading')} : {t('cartography.viewer.legend.hypothesis')} ;{' '}
        {t('cartography.viewer.legend.finding')} ; {t('cartography.viewer.legend.discrepancy')}.
      </p>

      <p role="status" className="pr-visually-hidden" data-testid="viewer-announcement">
        {announcement}
      </p>

      <div className="map-layout">
        <section className="map-main" aria-label={t('cartography.viewer.views.label')}>
          {view === 'simple' ? (
            <SimpleView
              outline={outline}
              title={title}
              markers={markers}
              selectedId={selectedId}
              onSelect={select}
              onOpen={open}
            />
          ) : null}
          {view === 'text' ? (
            <TextView
              model={model}
              outline={outline}
              title={title}
              markers={markers}
              selectedId={selectedId}
              onSelect={select}
              onOpen={open}
            />
          ) : null}
          {view === 'bpmn' ? (
            <BpmnView
              missionId={missionId}
              diagram={diagram}
              title={title}
              outline={outline}
              version={model.version}
              markers={markers}
              selectedId={selectedId}
              onSelect={select}
              onOpen={open}
              onShowText={() => setView(TEXT_VIEW)}
            />
          ) : null}
        </section>
        <ElementPanel
          missionId={missionId}
          model={model}
          outline={outline}
          selectedId={selectedId}
          canEdit={canEdit}
          onOpen={open}
        />
      </div>
    </div>
  );
}
