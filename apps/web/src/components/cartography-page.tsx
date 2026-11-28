'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FlowDecisionRequest, FlowOverviewDto, FlowProcessDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import {
  Button,
  DataTable,
  Notice,
  ProgressMeter,
  StatusBadge,
  Tabs,
  showToast,
} from '@processia/ui';
import { useCollab, useMissionModel } from '../lib/collab';
import {
  flowCounts,
  groupByMacro,
  mappingOpen,
  processPending,
  type MacroGroup,
} from '../lib/cartography';
import { endpoints } from '../lib/endpoints';
import { errorMessage } from '../lib/errors';
import { activeRun } from '../lib/guided';
import { useGuidedRuns } from '../lib/guided-runs';
import { MappingViewer } from './mapping/mapping-viewer';
import { useMission } from './mission-frame';

const TAB_VIEWER = 'viewer';
const TAB_FLOWS = 'flows';
const WATCHED = ['process_flow'] as const;
const ACCEPT: FlowDecisionRequest = { decision: 'accept' };
const REJECT: FlowDecisionRequest = { decision: 'reject' };

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; overview: FlowOverviewDto };

interface RowProps {
  process: FlowProcessDto;
  canEdit: boolean;
  /** Un lot est en cours : plus aucun lancement. */
  busy: boolean;
  onBuild: (process: FlowProcessDto) => void;
  onDetail: (taskId: string) => void;
  onDecide: (process: FlowProcessDto, decision: FlowDecisionRequest) => Promise<void>;
}

function ProcessRow({ process, canEdit, busy, onBuild, onDetail, onDecide }: RowProps) {
  const [confirmReject, setConfirmReject] = useState(false);
  const [working, setWorking] = useState(false);
  const pending = processPending(process);
  const label = `${process.code} ${process.label}`;

  async function decide(decision: FlowDecisionRequest): Promise<void> {
    setWorking(true);
    try {
      await onDecide(process, decision);
    } finally {
      setWorking(false);
      setConfirmReject(false);
    }
  }

  return (
    <tr data-testid="flow-row" data-process-code={process.code}>
      <th scope="row">
        <span className="mono">{process.code}</span> {process.label}
      </th>
      <td>
        {process.flowBuilt ? (
          <div className="stack-sm">
            <span>{t('cartography.flow.built', { count: process.nodeCount })}</span>
            {pending > 0 ? (
              <StatusBadge tone="warning">
                {t('cartography.flow.pending', { count: pending })}
              </StatusBadge>
            ) : (
              <StatusBadge tone="success">{t('cartography.flow.reviewed')}</StatusBadge>
            )}
          </div>
        ) : (
          <StatusBadge>{t('cartography.flow.none')}</StatusBadge>
        )}
      </td>
      <td>
        {process.tasks.length === 0 ? (
          <span className="muted small">{t('cartography.task.none')}</span>
        ) : (
          <ul className="plain stack-sm">
            {process.tasks.map((task) => (
              <li key={task.id} className="stack-sm" data-testid="flow-task">
                <span className="small">
                  <span className="mono">{task.code}</span> {task.label}
                </span>
                {task.detailed ? (
                  <span className="small">
                    {t('cartography.task.built')}
                    {task.pendingCount > 0
                      ? ` · ${t('cartography.task.pending', { count: task.pendingCount })}`
                      : ''}
                  </span>
                ) : canEdit ? (
                  <span>
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      aria-label={t('cartography.task.detailLabel', { label: task.label })}
                      onPress={() => onDetail(task.id)}
                    >
                      {t('cartography.task.detail')}
                    </Button>
                  </span>
                ) : null}
                {task.detailed && task.pendingCount > 0 && canEdit ? (
                  <span>
                    <Button
                      variant="quiet"
                      isDisabled={working}
                      aria-label={t('cartography.task.acceptLabel', { label: task.label })}
                      onPress={() => void decide({ ...ACCEPT, taskId: task.id })}
                    >
                      {t('cartography.task.accept')}
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>
        {!canEdit ? null : confirmReject ? (
          <div className="stack-sm">
            <p className="small">{t('cartography.rejectConfirm', { label })}</p>
            <div className="row">
              <Button variant="danger" isDisabled={working} onPress={() => void decide(REJECT)}>
                {t('cartography.rejectYes')}
              </Button>
              <Button variant="quiet" isDisabled={working} onPress={() => setConfirmReject(false)}>
                {t('cartography.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="row">
            {!process.flowBuilt ? (
              <Button
                variant="secondary"
                isDisabled={busy}
                aria-label={t('cartography.buildLabel', { label })}
                onPress={() => onBuild(process)}
              >
                {t('cartography.build')}
              </Button>
            ) : null}
            {pending > 0 ? (
              <>
                <Button
                  isDisabled={working}
                  aria-label={t('cartography.acceptLabel', { label })}
                  onPress={() => void decide(ACCEPT)}
                >
                  {t('cartography.accept')}
                </Button>
                <Button
                  variant="danger"
                  isDisabled={working}
                  aria-label={t('cartography.rejectLabel', { label })}
                  onPress={() => setConfirmReject(true)}
                >
                  {t('cartography.reject')}
                </Button>
              </>
            ) : null}
          </div>
        )}
      </td>
    </tr>
  );
}

function MacroTable({ group, ...rest }: { group: MacroGroup } & Omit<RowProps, 'process'>) {
  const headingId = `macro-${group.macroCode}`;
  return (
    <section aria-labelledby={headingId} className="stack" data-testid="flow-macro">
      <h2 id={headingId} className="h4">
        <span className="mono">{group.macroCode}</span> {group.macroLabel}
      </h2>
      <DataTable caption={t('cartography.tableCaption', { macro: group.macroLabel })}>
        <thead>
          <tr>
            <th scope="col">{t('cartography.columns.process')}</th>
            <th scope="col">{t('cartography.columns.flow')}</th>
            <th scope="col">{t('cartography.columns.tasks')}</th>
            <th scope="col">{t('cartography.columns.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {group.processes.map((process) => (
            <ProcessRow key={process.id} process={process} {...rest} />
          ))}
        </tbody>
      </DataTable>
    </section>
  );
}

/**
 * Page « Cartographie » (WP-17) : construit les enchaînements des processus (niveau 2, tous ou un
 * à un) et le détail des tâches (niveau 3), suit la progression du lot, et permet de confirmer
 * ou d'écarter d'un coup les hypothèses d'un processus. Chaque élément reste décidable un par un
 * depuis « Hypothèses à examiner » de l'espace Analyse. La visionneuse BPMN relève de WP-19.
 */
export function CartographyPage() {
  const mission = useMission();
  const missionId = mission.id;
  const { canEdit } = useCollab();
  const model = useMissionModel();
  const headVersion = model?.version ?? null;
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [announcement, setAnnouncement] = useState('');
  const [tab, setTab] = useState<typeof TAB_VIEWER | typeof TAB_FLOWS>(TAB_VIEWER);
  const open = mappingOpen(mission.phase);
  const isValidator = mission.myRole === 'validator';
  const reloadRef = useRef<() => Promise<void>>(async () => {});

  const { runs, track } = useGuidedRuns(missionId, WATCHED, ({ run, dto, mine }) => {
    void reloadRef.current();
    if (!mine) return;
    if (run.status === 'failed') {
      showToast({
        tone: 'error',
        title: t('cartography.failed'),
        description: t('cartography.failedDetail'),
      });
      return;
    }
    showToast({
      tone: 'success',
      title: t('cartography.done'),
      description:
        dto?.resultVersion === null || dto === null
          ? undefined
          : t('cartography.doneVersion', { version: dto.resultVersion }),
    });
  });

  const reload = useCallback(async () => {
    try {
      const overview = await endpoints.flowOverview(missionId);
      setLoaded({ status: 'ready', overview });
      const last = overview.lastRun;
      if (last !== null && (last.status === 'queued' || last.status === 'running')) {
        track(last.runId, 'process_flow');
      }
    } catch (error) {
      setLoaded((previous) =>
        previous.status === 'ready' ? previous : { status: 'error', message: errorMessage(error) },
      );
    }
  }, [missionId, track]);
  reloadRef.current = reload;

  useEffect(() => {
    if (!open || isValidator) return;
    void reload();
  }, [open, isValidator, reload, headVersion]);

  async function start(request: {
    processIds?: string[];
    detailTaskIds?: string[];
  }): Promise<void> {
    try {
      const started = await endpoints.startFlows(missionId, request);
      track(started.runId, 'process_flow');
      showToast({ tone: 'info', title: t('cartography.started') });
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }

  async function decide(process: FlowProcessDto, decision: FlowDecisionRequest): Promise<void> {
    try {
      const result = await endpoints.decideFlow(missionId, process.id, decision);
      setAnnouncement(
        result.outcome === 'rejected'
          ? t('cartography.rejected', { count: result.count })
          : t('cartography.decided', { count: result.count }),
      );
      await reload();
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }

  if (isValidator) {
    return (
      <div className="stack-lg">
        <h1>{t('cartography.heading')}</h1>
        <Notice tone="info">{t('cartography.validatorNotice')}</Notice>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="stack-lg">
        <h1>{t('cartography.heading')}</h1>
        <p className="muted">{t('cartography.intro')}</p>
        <Notice tone="info" role="status">
          {t('cartography.locked')}{' '}
          <Link href={`/missions/${missionId}/validation`}>{t('cartography.lockedLink')}</Link>
        </Notice>
      </div>
    );
  }

  const running = activeRun(runs, 'process_flow');
  const overview = loaded.status === 'ready' ? loaded.overview : null;
  const counts = flowCounts(overview);
  const failures = overview?.lastRun?.failures ?? [];
  const groups = groupByMacro(overview?.processes ?? []);

  const flows = (
    <div className="stack-lg" data-testid="flows-panel">
      <div className="page-head">
        <div className="stack-sm">
          <h2 className="h2">{t('cartography.flowsHeading')}</h2>
          <p className="muted">{t('cartography.intro')}</p>
          {overview !== null ? (
            <p className="muted small" data-testid="flow-summary">
              {t('cartography.summary', { built: counts.built, total: counts.total })}
            </p>
          ) : null}
        </div>
        <Link
          href={`/missions/${missionId}/analyse#hypotheses`}
          className="pr-button pr-button--secondary"
        >
          {t('cartography.reviewLink')}
        </Link>
      </div>
      {canEdit ? (
        <div className="stack-sm">
          <div className="row">
            <Button
              isDisabled={running !== null || counts.toBuild === 0}
              onPress={() => void start({})}
            >
              {t('cartography.buildAll')}
            </Button>
          </div>
          <p className="muted small">{t('cartography.buildAllHelp')}</p>
        </div>
      ) : null}

      {running !== null ? (
        <div role="status" className="stack-sm" data-testid="flow-progress">
          <ProgressMeter
            value={running.progress / 100}
            label={t('cartography.progress')}
            valueText={t('cartography.progressText', { percent: running.progress })}
          />
        </div>
      ) : null}

      <p role="status" className="small" data-testid="flow-announcement">
        {announcement}
      </p>

      {failures.length > 0 && running === null ? (
        <Notice tone="warning" role="alert">
          <p className="strong">{t('cartography.failuresHeading')}</p>
          <ul className="plain">
            {failures.map((failure) => (
              <li key={`${failure.code}-${failure.error}`} data-testid="flow-failure">
                {t('cartography.failureItem', { code: failure.code, error: failure.error })}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {loaded.status === 'loading' ? <p role="status">{t('cartography.loading')}</p> : null}
      {loaded.status === 'error' ? (
        <Notice tone="danger" role="alert">
          {loaded.message}
        </Notice>
      ) : null}

      {groups.map((group) => (
        <MacroTable
          key={group.macroCode}
          group={group}
          canEdit={canEdit}
          busy={running !== null}
          onBuild={(process) => void start({ processIds: [process.id] })}
          onDetail={(taskId) => void start({ detailTaskIds: [taskId] })}
          onDecide={decide}
        />
      ))}
    </div>
  );

  return (
    <div className="stack-lg" data-testid="cartography">
      <h1>{t('cartography.heading')}</h1>
      <Tabs
        label={t('cartography.tabs.label')}
        selected={tab}
        onSelectionChange={(id) => setTab(id === TAB_FLOWS ? TAB_FLOWS : TAB_VIEWER)}
        items={[
          {
            id: TAB_VIEWER,
            label: t('cartography.tabs.viewer'),
            content:
              model === null ? (
                <p role="status" className="muted">
                  {t('cartography.viewer.loading')}
                </p>
              ) : (
                <MappingViewer missionId={missionId} model={model} canEdit={canEdit} />
              ),
          },
          { id: TAB_FLOWS, label: t('cartography.tabs.flows'), content: flows },
        ]}
      />
    </div>
  );
}
