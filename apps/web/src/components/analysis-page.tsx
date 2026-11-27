'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SourceDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import type { SourceRef } from '@processia/model';
import { Button, Notice, ProgressMeter, showToast } from '@processia/ui';
import {
  applyRunMessage,
  elementsByTab,
  hasPendingSources,
  isActive,
  type AnalysisTab,
  type ExtractionRunState,
} from '../lib/analysis';
import { ApiRequestError } from '../lib/api';
import { useCollab, useMissionEvents, useMissionModel, usePublishView } from '../lib/collab';
import { endpoints } from '../lib/endpoints';
import { errorMessage } from '../lib/errors';
import { ConceptsSection, type StatusFilter } from './analysis/concepts-section';
import { HistorySection } from './analysis/history-section';
import { SourceViewer, type ViewerTarget } from './analysis/source-viewer';
import { SourcesSection, sourceTitle } from './analysis/sources-section';
import { DescriptionEditor } from './description-editor';
import { useMission } from './mission-frame';

const POLL_MS = 1500;
const DISCREPANCIES: AnalysisTab = 'discrepancies';
const ALL: StatusFilter = 'all';
const SCROLL_TO_TOP: ScrollIntoViewOptions = { block: 'start' };

/**
 * Espace « Analyse » (WP-13) : description partagée et bouton « Analyser », sources et état de
 * leur lecture, éléments du modèle par concept (statut, origine, citations vers la visionneuse),
 * complétude, écarts, historique des versions avec retour arrière.
 */
export function AnalysisPage() {
  const mission = useMission();
  const { canEdit, self, flushWorkspace } = useCollab();
  const model = useMissionModel();
  const missionId = mission.id;

  const [sources, setSources] = useState<SourceDto[] | null>(null);
  const [run, setRun] = useState<ExtractionRunState | null>(null);
  const [tab, setTab] = useState<AnalysisTab>('business');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const localRun = useRef<string | null>(null);
  const toasted = useRef(new Set<string>());
  const pendingHash = useRef<string | null>(null);
  const conceptsRef = useRef<HTMLDivElement>(null);

  const isValidator = mission.myRole === 'validator';

  const refreshSources = useCallback(async () => {
    try {
      setSources(await endpoints.listSources(missionId));
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.code === 'FORBIDDEN')) {
        showToast({ tone: 'error', title: errorMessage(error) });
      }
    }
  }, [missionId]);

  // Sources : chargées à l'ouverture, puis à chaque message de progression et nouvelle version.
  useEffect(() => {
    if (!isValidator) void refreshSources();
  }, [isValidator, refreshSources, model?.version]);

  useMissionEvents((message) => {
    if (message.type !== 'run.progress') return;
    setRun((previous) => applyRunMessage(previous, message));
    void refreshSources();
  });

  // Repli sans coédition : interroge les textes en cours de lecture et l'extraction suivie.
  const pending = sources !== null && hasPendingSources(sources);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refreshSources(), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, refreshSources]);

  const active = isActive(run);
  const activeRunId = active ? (run?.runId ?? null) : null;
  useEffect(() => {
    if (activeRunId === null) return;
    const timer = setInterval(() => {
      void endpoints
        .getRun(missionId, activeRunId)
        .then((dto) =>
          setRun((previous) =>
            applyRunMessage(previous, {
              type: 'run.progress',
              missionId,
              runId: dto.id,
              kind: dto.kind,
              status: dto.status,
              progress: dto.progress,
              sourceId: previous?.sourceId ?? null,
              error: dto.error,
            }),
          ),
        )
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [missionId, activeRunId]);

  // Fin d'une extraction : un message pour tous ceux qui suivent l'exécution.
  useEffect(() => {
    if (run === null || isActive(run) || toasted.current.has(run.runId)) return;
    toasted.current.add(run.runId);
    void refreshSources();
    if (run.status === 'failed') {
      showToast({
        tone: 'error',
        title: t('analysis.analyze.failed'),
        description: t('analysis.analyze.failedDetail'),
      });
      return;
    }
    void endpoints
      .getRun(missionId, run.runId)
      .then((dto) =>
        showToast({
          tone: 'success',
          title: t('analysis.analyze.done'),
          description:
            dto.resultVersion === null
              ? t('analysis.analyze.doneNoChange')
              : t('analysis.analyze.doneVersion', { version: dto.resultVersion }),
        }),
      )
      .catch(() => showToast({ tone: 'success', title: t('analysis.analyze.done') }));
  }, [run, missionId, refreshSources]);

  async function analyze(sourceId?: string): Promise<void> {
    try {
      // La description est figée depuis la base : on y enregistre d'abord ce qui vient d'être saisi.
      if (sourceId === undefined) await flushWorkspace();
      const started = await endpoints.startExtraction(missionId, sourceId);
      localRun.current = started.runId;
      setRun({
        runId: started.runId,
        status: 'queued',
        progress: 0,
        error: null,
        sourceId: started.source.id,
      });
      await refreshSources();
    } catch (error) {
      const empty =
        sourceId === undefined &&
        error instanceof ApiRequestError &&
        error.code === 'VALIDATION_ERROR';
      showToast({
        tone: 'error',
        title: empty ? t('analysis.analyze.emptyDescription') : errorMessage(error),
      });
    }
  }

  // Liens du tableau de bord : `#hypotheses` (hypothèses à examiner), `#contradictions` (écarts).
  useEffect(() => {
    pendingHash.current = window.location.hash.replace('#', '') || null;
  }, []);
  useEffect(() => {
    if (model === null || pendingHash.current === null) return;
    const wanted = pendingHash.current;
    pendingHash.current = null;
    const byTab = elementsByTab(model);
    if (wanted === 'hypotheses') {
      const first = (Object.keys(byTab) as AnalysisTab[]).find((id) =>
        byTab[id].some((element) => element.status.value === 'hypothesis'),
      );
      if (first !== undefined) {
        setTab(first);
        setFilter('hypothesis');
      }
    } else if (wanted === 'contradictions') {
      setTab('discrepancies');
    }
  }, [model]);

  // Vue consultée, publiée aux autres consultants (« en train de… »).
  const tabLabel =
    tab === 'discrepancies' ? t('analysis.concepts.discrepancies') : t(`dashboard.concepts.${tab}`);
  const selectedLabel = selectedId === null ? undefined : model?.elements[selectedId]?.label;
  usePublishView(
    isValidator
      ? undefined
      : selectedLabel === undefined
        ? t('analysis.view.tab', { tab: tabLabel })
        : t('analysis.view.element', { tab: tabLabel, element: selectedLabel }),
  );

  const titleOf = useMemo(() => {
    const byId = new Map((sources ?? []).map((source) => [source.id, sourceTitle(source)]));
    return (sourceId: string) => byId.get(sourceId) ?? sourceId;
  }, [sources]);

  function openCitation(reference: SourceRef): void {
    setViewer({
      sourceId: reference.sourceId,
      title: titleOf(reference.sourceId),
      chunkId: reference.chunkId,
      charStart: reference.locator.charStart,
      charEnd: reference.locator.charEnd,
    });
  }

  if (isValidator) {
    return (
      <div className="stack-lg">
        <h1>{t('analysis.heading')}</h1>
        <Notice tone="info">{t('analysis.validatorNotice')}</Notice>
      </div>
    );
  }

  return (
    <div className="stack-lg analysis">
      <div className="stack-sm">
        <h1>{t('analysis.heading')}</h1>
        <p className="muted">{t('analysis.intro')}</p>
        <p className="muted small" data-testid="model-version">
          {model === null
            ? t('collab.model.none')
            : t('collab.model.version', { version: model.version })}
        </p>
      </div>

      <div className="grid-2">
        <section aria-labelledby="analysis-description" className="card stack">
          <div className="stack-sm">
            <h2 id="analysis-description" className="h3">
              {t('collab.description.heading')}
            </h2>
            <p className="muted small">{t('collab.description.help')}</p>
          </div>
          <DescriptionEditor />
          <div className="stack">
            {canEdit ? (
              <>
                <div className="row">
                  <Button isDisabled={active} onPress={() => void analyze()}>
                    {active ? t('analysis.analyze.running') : t('analysis.analyze.button')}
                  </Button>
                </div>
                <p className="muted small">{t('analysis.analyze.help')}</p>
              </>
            ) : (
              <p className="muted small">{t('analysis.analyze.readOnly')}</p>
            )}
            {active && run !== null ? (
              <div className="stack-sm" data-testid="analysis-progress">
                <ProgressMeter
                  value={run.progress / 100}
                  label={t('analysis.analyze.progressLabel')}
                  valueText={t('analysis.analyze.progressText', { percent: run.progress })}
                />
                {localRun.current !== run.runId ? (
                  <p className="muted small" role="status">
                    {t('analysis.analyze.otherRunning')}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        <SourcesSection
          missionId={missionId}
          sources={sources}
          model={model}
          canEdit={canEdit}
          busy={active}
          onAnalyze={(sourceId) => void analyze(sourceId)}
          onUploaded={() => void refreshSources()}
          onOpen={setViewer}
          onSeeDiscrepancies={() => {
            setTab(DISCREPANCIES);
            setFilter(ALL);
            conceptsRef.current?.scrollIntoView(SCROLL_TO_TOP);
          }}
        />
      </div>

      <div ref={conceptsRef}>
        <ConceptsSection
          model={model}
          tab={tab}
          onTabChange={(next) => {
            setTab(next);
            setSelectedId(null);
          }}
          selectedId={selectedId}
          onSelect={setSelectedId}
          filter={filter}
          onFilterChange={setFilter}
          titleOf={titleOf}
          onOpenCitation={openCitation}
        />
      </div>

      <HistorySection
        missionId={missionId}
        headVersion={model?.version ?? null}
        selfId={self.id}
        canRollback={canEdit}
      />

      <SourceViewer missionId={missionId} target={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
