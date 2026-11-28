'use client';

import { t } from '@processia/i18n';
import type { BusinessModel, DiagramOutline, OutlineNode } from '@processia/model';
import { DataTable } from '@processia/ui';
import { nextSteps, type NodeMarkers } from '../../lib/mapping';
import { groupName, natureLabel } from './labels';
import { MarkerTags } from './simple-view';

interface Props {
  model: BusinessModel;
  outline: DiagramOutline;
  title: string;
  markers: Map<string, NodeMarkers>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (diagram: string) => void;
}

function dataLabels(model: BusinessModel, ids: readonly string[]): string[] {
  return ids.flatMap((id) => {
    const el = model.elements[id];
    return el === undefined ? [] : [el.label];
  });
}

function ioOf(model: BusinessModel, node: OutlineNode): { inputs: string[]; outputs: string[] } {
  const el = model.elements[node.id];
  if (el?.kind !== 'activity') return { inputs: [], outputs: [] };
  return { inputs: dataLabels(model, el.inputs), outputs: dataLabels(model, el.outputs) };
}

/**
 * Alternative textuelle accessible (RGAA, spécification 6.3) : le tableau des étapes dans l'ordre
 * de lecture, avec l'acteur, les entrées, les sorties, et pour chaque étape la suite ou les
 * branches d'une décision. Lié à la sélection : l'étape choisie dans une autre vue y est repérée
 * (`aria-current`) et inversement. Entièrement navigable au clavier.
 */
export function TextView({ model, outline, title, markers, selectedId, onSelect, onOpen }: Props) {
  if (outline.nodes.length === 0) {
    return <p className="muted">{t('cartography.viewer.simple.empty')}</p>;
  }
  return (
    <div className="stack-sm" data-testid="text-view">
      <p className="muted small" role="status">
        {t('cartography.viewer.text.count', { count: outline.nodes.length })}
      </p>
      <DataTable caption={t('cartography.viewer.text.caption', { title })}>
        <thead>
          <tr>
            <th scope="col">{t('cartography.viewer.text.columns.number')}</th>
            <th scope="col">{t('cartography.viewer.text.columns.step')}</th>
            <th scope="col">{t('cartography.viewer.text.columns.type')}</th>
            <th scope="col">{t('cartography.viewer.text.columns.actor')}</th>
            <th scope="col">{t('cartography.viewer.text.columns.inputs')}</th>
            <th scope="col">{t('cartography.viewer.text.columns.outputs')}</th>
            <th scope="col">{t('cartography.viewer.text.columns.next')}</th>
          </tr>
        </thead>
        <tbody>
          {outline.nodes.map((node) => {
            const selected = node.id === selectedId;
            const io = ioOf(model, node);
            const next = nextSteps(outline, node.id);
            return (
              <tr
                key={node.id}
                className={selected ? 'map-row is-selected' : 'map-row'}
                aria-current={selected ? 'true' : undefined}
                data-testid="text-row"
                data-element-id={node.id}
                data-element-code={node.code}
              >
                <th scope="row" className="mono">
                  {node.number}
                </th>
                <td>
                  <div className="stack-sm">
                    <button
                      type="button"
                      className="map-link"
                      aria-pressed={selected}
                      aria-label={t('cartography.viewer.text.select', {
                        number: node.number,
                        label: node.label,
                      })}
                      onClick={() => onSelect(node.id)}
                    >
                      {node.label}
                    </button>
                    <span className="map-card-tags">
                      <MarkerTags markers={markers.get(node.id)} />
                    </span>
                    {node.drillTo !== undefined ? (
                      <span>
                        <button
                          type="button"
                          className="map-link map-link--secondary"
                          aria-label={t('cartography.viewer.text.openLabel', {
                            number: node.number,
                            label: node.label,
                          })}
                          onClick={() => onOpen(node.drillTo as string)}
                          data-testid="text-open"
                        >
                          {t('cartography.viewer.text.open')}
                        </button>
                      </span>
                    ) : null}
                  </div>
                </td>
                <td>{natureLabel(node)}</td>
                <td>{groupName(outline, node.groupId)}</td>
                <td>
                  {io.inputs.length > 0 ? io.inputs.join(' ; ') : t('cartography.viewer.text.none')}
                </td>
                <td>
                  {io.outputs.length > 0
                    ? io.outputs.join(' ; ')
                    : t('cartography.viewer.text.none')}
                </td>
                <td>
                  {next.length === 0 ? (
                    node.kind === 'end' ? (
                      t('cartography.viewer.text.end')
                    ) : (
                      t('cartography.viewer.text.none')
                    )
                  ) : (
                    <ul className="plain">
                      {next.map((n) => (
                        <li key={n.node.id}>
                          {n.label !== undefined
                            ? t('cartography.viewer.text.branch', {
                                condition: n.label,
                                number: n.node.number,
                              })
                            : n.isDefault
                              ? t('cartography.viewer.text.branchDefault', {
                                  number: n.node.number,
                                })
                              : t('cartography.viewer.text.plain', { number: n.node.number })}
                          {` · ${n.node.label}`}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
}
