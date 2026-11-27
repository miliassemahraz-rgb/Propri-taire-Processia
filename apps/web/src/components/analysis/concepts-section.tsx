'use client';

import { useMemo } from 'react';
import { t } from '@processia/i18n';
import {
  completeness,
  ELEMENT_STATUSES,
  type BusinessModel,
  type Concept,
  type Element,
  type ElementStatus,
  type SourceRef,
} from '@processia/model';
import { Button, Select, Tabs } from '@processia/ui';
import { ANALYSIS_TABS, elementsByTab, labelOf, type AnalysisTab } from '../../lib/analysis';
import { formatDate } from '../../lib/format';
import { useMode } from '../../lib/mode';
import { ElementStatusBadge } from './element-status';

export type StatusFilter = ElementStatus | 'all';

const MAX_GAPS_SHOWN = 8;

function tabName(tab: AnalysisTab): string {
  return tab === 'discrepancies'
    ? t('analysis.concepts.discrepancies')
    : t(`dashboard.concepts.${tab}`);
}

/** Lignes « libellé : valeur » propres à chaque nature d'élément. */
function detailRows(element: Element, model: BusinessModel): { label: string; value: string }[] {
  switch (element.kind) {
    case 'activity': {
      const rows = [
        { label: t('analysis.field.level'), value: t(`analysis.level.${element.level}`) },
      ];
      if (element.scope !== undefined) {
        rows.push({
          label: t('analysis.field.scope'),
          value: t(`analysis.scope.${element.scope}`),
        });
      }
      if (element.responsibleActorId !== undefined) {
        rows.push({
          label: t('analysis.field.responsible'),
          value: labelOf(model, element.responsibleActorId),
        });
      }
      return rows;
    }
    case 'actor': {
      const rows = [
        {
          label: t('analysis.field.category'),
          value: t(`analysis.actorCategory.${element.category}`),
        },
      ];
      if (element.responsibilities.length > 0) {
        rows.push({
          label: t('analysis.field.responsibilities'),
          value: element.responsibilities.join(' ; '),
        });
      }
      return rows;
    }
    case 'business_trait':
      return [
        { label: t('analysis.field.facet'), value: t(`analysis.facet.${element.facet}`) },
        { label: t('analysis.field.text'), value: element.text },
      ];
    case 'glossary_term':
      return [{ label: t('analysis.field.definition'), value: element.definition }];
    case 'rule':
      return [{ label: t('analysis.field.statement'), value: element.statement.text }];
    default:
      return [];
  }
}

function Citation({
  reference,
  title,
  onOpen,
}: {
  reference: SourceRef;
  title: string;
  onOpen: (reference: SourceRef) => void;
}) {
  return (
    <li className="citation">
      <blockquote className="citation-quote">{reference.quote}</blockquote>
      <p className="muted small">{title}</p>
      <Button
        variant="secondary"
        aria-label={t('analysis.fiche.citationOpenLabel', { quote: reference.quote })}
        onPress={() => onOpen(reference)}
      >
        {t('analysis.fiche.citationOpen')}
      </Button>
    </li>
  );
}

function Fiche({
  element,
  model,
  titleOf,
  onOpenCitation,
}: {
  element: Element;
  model: BusinessModel;
  titleOf: (sourceId: string) => string;
  onOpenCitation: (reference: SourceRef) => void;
}) {
  const { mode } = useMode();
  const { provenance } = element;
  const rows = detailRows(element, model);
  return (
    <article className="stack fiche" aria-labelledby="fiche-title" data-testid="fiche">
      <div className="stack-sm">
        <h3 id="fiche-title" className="h3">
          {element.label}
        </h3>
        <div className="row">
          <ElementStatusBadge status={element.status.value} />
          <span className="muted small">{t(`analysis.kind.${element.kind}`)}</span>
          <span className="muted small">
            {t('analysis.fiche.code')} {element.code}
          </span>
        </div>
      </div>
      {element.description !== undefined && element.description !== '' ? (
        <p>{element.description}</p>
      ) : null}
      {rows.length > 0 ? (
        <dl className="fiche-fields">
          {rows.map((row) => (
            <div key={row.label}>
              <dt className="muted small">{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="small">
        <span className="strong">{t('analysis.fiche.origin')} : </span>
        {t(`analysis.origin.${provenance.origin}`)}
        {provenance.confidence === undefined
          ? ''
          : ` · ${t('analysis.fiche.confidence', { percent: Math.round(provenance.confidence * 100) })}`}
      </p>
      {provenance.rationale !== undefined ? (
        <p className="small">
          <span className="strong">{t('analysis.fiche.rationale')} : </span>
          {provenance.rationale}
        </p>
      ) : null}
      {element.status.decidedAt !== undefined ? (
        <p className="muted small">
          {t('analysis.fiche.decided', { date: formatDate(element.status.decidedAt) })}
        </p>
      ) : null}
      {element.kind === 'discrepancy' ? (
        <div className="stack">
          <p className="small">
            <span className="strong">{t('analysis.fiche.status')} : </span>
            {t(
              element.state === 'open'
                ? 'analysis.discrepancy.open'
                : 'analysis.discrepancy.resolved',
            )}
          </p>
          {element.resolution !== undefined ? (
            <p className="small">
              {t('analysis.discrepancy.resolution', { note: element.resolution.note })}
            </p>
          ) : null}
          <ul className="plain stack">
            {element.sides.map((side, index) => (
              <li key={`${index}-${side.claim}`} className="card-soft stack-sm">
                <p className="strong">
                  {t('analysis.field.side', { number: index + 1 })} : {side.claim}
                </p>
                <ul className="plain stack">
                  {side.refs.map((reference) => (
                    <Citation
                      key={`${reference.sourceId}-${reference.locator.charStart}`}
                      reference={reference}
                      title={titleOf(reference.sourceId)}
                      onOpen={onOpenCitation}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {element.elementIds.length > 0 ? (
            <p className="small">
              <span className="strong">{t('analysis.fiche.elements')} : </span>
              {element.elementIds.map((id) => labelOf(model, id)).join(', ')}
            </p>
          ) : null}
        </div>
      ) : null}
      {element.kind === 'discrepancy' ? null : (
        <section aria-labelledby="fiche-citations" className="stack">
          <h4 id="fiche-citations" className="h4">
            {t('analysis.fiche.citations')}
          </h4>
          {provenance.refs.length === 0 ? (
            <p className="muted small">{t('analysis.fiche.noCitation')}</p>
          ) : (
            <ul className="plain stack">
              {provenance.refs.map((reference) => (
                <Citation
                  key={`${reference.sourceId}-${reference.sourceRevision}-${reference.locator.charStart}`}
                  reference={reference}
                  title={titleOf(reference.sourceId)}
                  onOpen={onOpenCitation}
                />
              ))}
            </ul>
          )}
        </section>
      )}
      {mode === 'expert' ? (
        <div className="muted small stack-sm" data-testid="fiche-expert">
          <p>{t('analysis.fiche.expertId', { id: element.id })}</p>
          <p>
            {t('analysis.fiche.expertVersions', {
              created: element.meta.createdInVersion,
              updated: element.meta.updatedInVersion,
            })}
          </p>
        </div>
      ) : null}
    </article>
  );
}

function ConceptPanel({
  tab,
  model,
  elements,
  selectedId,
  onSelect,
  filter,
  onFilterChange,
  titleOf,
  onOpenCitation,
}: {
  tab: AnalysisTab;
  model: BusinessModel;
  elements: Element[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: StatusFilter;
  onFilterChange: (filter: StatusFilter) => void;
  titleOf: (sourceId: string) => string;
  onOpenCitation: (reference: SourceRef) => void;
}) {
  const report = useMemo(
    () => (tab === 'discrepancies' ? null : completeness(model)),
    [model, tab],
  );
  const entry = report === null ? null : report[tab as Concept];
  const shown = filter === 'all' ? elements : elements.filter((e) => e.status.value === filter);
  const selected = shown.find((e) => e.id === selectedId) ?? null;
  const name = tabName(tab);
  const options = [
    { id: 'all', label: t('analysis.concepts.filterAll') },
    ...ELEMENT_STATUSES.map((status) => ({ id: status, label: t(`analysis.status.${status}`) })),
  ];

  return (
    <div className="stack">
      {entry === null ? null : (
        <div className="stack-sm" data-testid={`completeness-${tab}`}>
          <p className="strong">
            {t('analysis.concepts.completeness', { percent: Math.round(entry.score * 100) })}
          </p>
          <div
            className="concept-bar concept-bar--wide"
            role="progressbar"
            aria-label={t('analysis.concepts.completenessBar', { name })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(entry.score * 100)}
          >
            <span style={{ width: `${Math.round(entry.score * 100)}%` }} />
          </div>
          {entry.gaps.length === 0 ? (
            <p className="muted small">{t('analysis.concepts.nothingMissing')}</p>
          ) : (
            <div className="small">
              <p className="strong">{t('analysis.concepts.missingHeading')}</p>
              <ul className="gaps">
                {entry.gaps.slice(0, MAX_GAPS_SHOWN).map((gap) => (
                  <li key={`${gap.check}-${gap.message}`}>{gap.message}</li>
                ))}
              </ul>
              {entry.gaps.length > MAX_GAPS_SHOWN ? (
                <p className="muted">
                  {t('analysis.concepts.moreGaps', { count: entry.gaps.length - MAX_GAPS_SHOWN })}
                </p>
              ) : null}
            </div>
          )}
        </div>
      )}

      <div className="concept-layout">
        <div className="stack">
          <Select
            label={t('analysis.concepts.filter')}
            options={options}
            value={filter}
            placeholder={t('analysis.concepts.filterAll')}
            onChange={(value) => onFilterChange(value as StatusFilter)}
          />
          {elements.length === 0 ? (
            <p className="muted">{t('analysis.concepts.empty')}</p>
          ) : shown.length === 0 ? (
            <p className="muted">{t('analysis.concepts.noMatch')}</p>
          ) : (
            <ul
              className="plain element-list"
              aria-label={t('analysis.concepts.listLabel', { name })}
            >
              {shown.map((element) => (
                <li key={element.id}>
                  <button
                    type="button"
                    className="element-row"
                    aria-current={element.id === selectedId ? 'true' : undefined}
                    onClick={() => onSelect(element.id)}
                  >
                    <span className="element-code">{element.code}</span>
                    <span className="element-label">{element.label}</span>
                    <ElementStatusBadge status={element.status.value} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <aside className="fiche-panel" aria-label={t('analysis.fiche.heading')}>
          {selected === null ? (
            <p className="muted">{t('analysis.fiche.none')}</p>
          ) : (
            <Fiche
              element={selected}
              model={model}
              titleOf={titleOf}
              onOpenCitation={onOpenCitation}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

interface Props {
  model: BusinessModel | null;
  tab: AnalysisTab;
  onTabChange: (tab: AnalysisTab) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: StatusFilter;
  onFilterChange: (filter: StatusFilter) => void;
  titleOf: (sourceId: string) => string;
  onOpenCitation: (reference: SourceRef) => void;
}

/** Onglets par concept (et écarts) : listes d'éléments, fiches avec citations, complétude. */
export function ConceptsSection({ model, tab, onTabChange, ...rest }: Props) {
  const byTab = useMemo(() => elementsByTab(model), [model]);
  return (
    <section aria-labelledby="analysis-concepts" className="card stack analysis-concepts">
      <h2 id="analysis-concepts" className="h3">
        {t('analysis.concepts.heading')}
      </h2>
      {model === null ? (
        <p className="muted">{t('analysis.concepts.noModel')}</p>
      ) : (
        <Tabs
          label={t('analysis.concepts.tabs')}
          selected={tab}
          onSelectionChange={(id) => onTabChange(id as AnalysisTab)}
          items={ANALYSIS_TABS.map((id) => ({
            id,
            label: t('analysis.concepts.tabWithCount', {
              name: tabName(id),
              count: byTab[id].length,
            }),
            content:
              id === tab ? (
                <ConceptPanel
                  tab={id}
                  model={model}
                  elements={byTab[id]}
                  selectedId={rest.selectedId}
                  onSelect={rest.onSelect}
                  filter={rest.filter}
                  onFilterChange={rest.onFilterChange}
                  titleOf={rest.titleOf}
                  onOpenCitation={rest.onOpenCitation}
                />
              ) : null,
          }))}
        />
      )}
    </section>
  );
}
