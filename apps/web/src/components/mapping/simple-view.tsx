'use client';

import { useId, useMemo } from 'react';
import { t } from '@processia/i18n';
import type { DiagramOutline, OutlineNode } from '@processia/model';
import { CARD_H, CARD_W, layoutSimple, nextSteps, type NodeMarkers } from '../../lib/mapping';
import { groupLabel, natureLabel } from './labels';

interface Props {
  outline: DiagramOutline;
  title: string;
  markers: Map<string, NodeMarkers>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (diagram: string) => void;
}

const shortLabel = (text: string): string => (text.length > 26 ? `${text.slice(0, 25)}…` : text);

/** Marqueurs en texte : jamais la couleur seule (RGAA 3.1). */
export function MarkerTags({ markers }: { markers: NodeMarkers | undefined }) {
  if (markers === undefined) return null;
  return (
    <>
      {markers.hypothesis ? (
        <span className="map-tag map-tag--hypothesis">
          <span aria-hidden="true">? </span>
          {t('cartography.viewer.marker.hypothesis')}
        </span>
      ) : null}
      {markers.findings > 0 ? (
        <span className="map-tag map-tag--finding">
          <span aria-hidden="true">! </span>
          {t('cartography.viewer.marker.finding')}
        </span>
      ) : null}
      {markers.discrepancies > 0 ? (
        <span className="map-tag map-tag--discrepancy">
          <span aria-hidden="true">≠ </span>
          {t('cartography.viewer.marker.discrepancy')}
        </span>
      ) : null}
    </>
  );
}

function branchLine(outline: DiagramOutline, node: OutlineNode): string {
  return nextSteps(outline, node.id)
    .map((next) =>
      next.label !== undefined
        ? t('cartography.viewer.simple.branch', {
            condition: shortLabel(next.label),
            number: next.node.number,
          })
        : next.isDefault
          ? t('cartography.viewer.simple.branchDefault', { number: next.node.number })
          : t('cartography.viewer.simple.branchPlain', { number: next.node.number }),
    )
    .join(' · ');
}

/**
 * Vue simplifiée (mode simple et validateur, spécification 6.3) : les étapes en cartes, une ligne
 * par acteur, reliées par des flèches ; les décisions se lisent comme des questions avec leurs
 * branches. Pas de notation BPMN. Les flèches sont décoratives : les mêmes enchaînements sont
 * dits en texte sur chaque carte et dans l'alternative textuelle.
 */
export function SimpleView({ outline, title, markers, selectedId, onSelect, onOpen }: Props) {
  const layout = useMemo(() => layoutSimple(outline), [outline]);
  const arrowId = useId();
  const byId = useMemo(() => new Map(outline.nodes.map((n) => [n.id, n])), [outline]);

  if (outline.nodes.length === 0) {
    return <p className="muted">{t('cartography.viewer.simple.empty')}</p>;
  }

  return (
    <div
      className="map-scroll"
      role="region"
      aria-label={t('cartography.viewer.simple.region', { title })}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      data-testid="simple-view"
    >
      <div className="map-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg
          className="map-arrows"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <marker
              id={`${arrowId}-head`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="map-arrow-head" />
            </marker>
          </defs>
          {layout.arrows.map((arrow) => (
            <g key={arrow.key}>
              <path
                d={arrow.path}
                className={arrow.derived ? 'map-arrow map-arrow--derived' : 'map-arrow'}
                markerEnd={`url(#${arrowId}-head)`}
                fill="none"
              />
              {arrow.label !== undefined ? (
                <text x={arrow.labelAt.x} y={arrow.labelAt.y} className="map-arrow-label">
                  {shortLabel(arrow.label)}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
        {layout.lanes.map((lane) => {
          const group = outline.groups.find((g) => g.id === lane.groupId);
          const name = group === undefined ? '' : groupLabel(group);
          return (
            <section
              key={lane.groupId ?? 'none'}
              className="map-lane"
              aria-label={t('cartography.viewer.simple.lane', { name })}
              style={{ top: lane.top, height: lane.height, width: layout.width }}
              data-testid="simple-lane"
            >
              <h3 className="map-lane-name">{name}</h3>
              <ol className="map-cards plain">
                {lane.nodeIds
                  .map((id) => byId.get(id))
                  .filter((n): n is OutlineNode => n !== undefined)
                  .sort((a, b) => a.number - b.number)
                  .map((node) => {
                    const place = layout.placements[node.id];
                    if (place === undefined) return null;
                    const selected = node.id === selectedId;
                    const branches = node.kind === 'decision' ? branchLine(outline, node) : '';
                    return (
                      <li
                        key={node.id}
                        className={
                          node.drillTo !== undefined
                            ? 'map-card-wrap map-card-wrap--drill'
                            : 'map-card-wrap'
                        }
                        style={{
                          left: place.x,
                          top: place.y - lane.top,
                          width: CARD_W,
                          height: CARD_H,
                        }}
                      >
                        <button
                          type="button"
                          className={[
                            'map-card',
                            `map-card--${node.kind}`,
                            node.status === 'hypothesis' ? 'map-card--hypothesis' : '',
                            selected ? 'is-selected' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          aria-pressed={selected}
                          onClick={() => onSelect(node.id)}
                          data-testid="simple-card"
                          data-element-id={node.id}
                          data-element-code={node.code}
                        >
                          <span className="map-card-meta">
                            <span className="map-card-num">{node.number}</span>
                            <span className="map-card-kind">{natureLabel(node)}</span>
                          </span>
                          <span className="map-card-label">{node.label}</span>
                          {branches !== '' ? (
                            <span className="map-card-branches" title={branches}>
                              {branches}
                            </span>
                          ) : null}
                          <span className="map-card-tags">
                            <MarkerTags markers={markers.get(node.id)} />
                          </span>
                        </button>
                        {node.drillTo !== undefined ? (
                          <button
                            type="button"
                            className="map-card-open"
                            aria-label={t('cartography.viewer.simple.openLabel', {
                              label: node.label,
                            })}
                            title={t('cartography.viewer.simple.open')}
                            onClick={() => onOpen(node.drillTo as string)}
                            data-testid="simple-open"
                          >
                            <span aria-hidden="true">↓</span>
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
              </ol>
            </section>
          );
        })}
      </div>
    </div>
  );
}
