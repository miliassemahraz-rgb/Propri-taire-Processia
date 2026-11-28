'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiagnosticOverviewDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import type { BusinessModel, Finding } from '@processia/model';
import {
  Button,
  Dialog,
  Notice,
  ProgressMeter,
  StatusBadge,
  TextField,
  showToast,
} from '@processia/ui';
import { useCollab, useMissionModel } from '../lib/collab';
import {
  FAMILY_PAGE_SIZE,
  diagnosticCounts,
  findingLocations,
  findingsOf,
  groupByFamily,
  severityKey,
  type FamilyGroup,
} from '../lib/diagnostic';
import { endpoints } from '../lib/endpoints';
import { ApiRequestError } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { activeRun } from '../lib/guided';
import { useGuidedRuns } from '../lib/guided-runs';
import { ElementStatusBadge } from './analysis/element-status';
import { useMission } from './mission-frame';

const WATCHED = ['diagnostic'] as const;

type Loaded =
  | { status: 'loading' }
  | { status: 'locked' }
  | { status: 'error'; message: string }
  | { status: 'ready'; overview: DiagnosticOverviewDto };

interface CardProps {
  finding: Finding;
  model: BusinessModel;
  missionId: string;
  canEdit: boolean;
  onConfirm: (finding: Finding) => Promise<void>;
  onReject: (finding: Finding, reason: string) => Promise<void>;
}

function FindingCard({ finding, model, missionId, canEdit, onConfirm, onReject }: CardProps) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const locations = findingLocations(model, missionId, finding);
  const titleId = `finding-${finding.id}`;
  const pending = finding.status.value === 'hypothesis';
  const detector = finding.detection.detectorId;

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      await onConfirm(finding);
    } finally {
      setBusy(false);
    }
  }
  async function reject(): Promise<void> {
    setBusy(true);
    try {
      await onReject(finding, reason.trim());
      setRejecting(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className="card-soft stack"
      aria-labelledby={titleId}
      data-testid="finding-card"
      data-finding-code={finding.code}
      data-finding-type={finding.type}
      data-finding-by={finding.detection.by}
      data-finding-status={finding.status.value}
    >
      <div className="row row-between">
        <span className="small strong muted">
          <span className="mono">{finding.code}</span> · {t(`diagnostic.type.${finding.type}`)}
        </span>
        <span className="row">
          <StatusBadge
            tone={
              finding.severity === 3 ? 'danger' : finding.severity === 2 ? 'warning' : 'neutral'
            }
          >
            {t('diagnostic.severityLabel')}{' '}
            {t(`diagnostic.severity.${severityKey(finding.severity)}`)}
          </StatusBadge>
          <ElementStatusBadge status={finding.status.value} />
        </span>
      </div>
      <p id={titleId} className="strong">
        {finding.label}
      </p>
      <p className="small">
        <span className="strong">{t('diagnostic.why')} : </span>
        {finding.evidence ?? finding.provenance.rationale ?? ''}
      </p>
      <p className="small muted" data-testid="finding-origin">
        {t('diagnostic.detectionLabel')} : {t(`diagnostic.detection.${finding.detection.by}`)}
        {detector === undefined ? '' : ` (${t('diagnostic.detector', { id: detector })})`} ·{' '}
        {t(`analysis.origin.${finding.provenance.origin}`)}
      </p>
      <div className="stack-sm">
        <p className="small strong">{t('diagnostic.where')}</p>
        <ul className="plain stack-sm" data-testid="finding-locations">
          {locations.map((location) => (
            <li key={location.id} className="small">
              {location.diagram === null ? (
                <span>
                  {t('diagnostic.notOnMap', { code: `${location.code} ${location.label}` })}
                </span>
              ) : (
                <Link
                  href={location.href}
                  aria-label={t('diagnostic.locationLink', { code: location.code })}
                  data-testid="finding-location-link"
                >
                  <span className="mono">{location.code}</span> {location.label}
                </Link>
              )}
            </li>
          ))}
        </ul>
      </div>
      {canEdit && pending ? (
        <div className="row">
          <Button
            isDisabled={busy}
            aria-label={t('diagnostic.confirmLabel', { code: finding.code })}
            onPress={() => void confirm()}
          >
            {t('diagnostic.confirm')}
          </Button>
          <Button
            variant="danger"
            isDisabled={busy}
            aria-label={t('diagnostic.rejectLabel', { code: finding.code })}
            onPress={() => setRejecting(true)}
          >
            {t('diagnostic.reject')}
          </Button>
          <Dialog
            title={t('diagnostic.rejectTitle', { code: finding.code })}
            isOpen={rejecting}
            onOpenChange={setRejecting}
          >
            <div className="stack">
              <p>{t('diagnostic.rejectBody')}</p>
              <TextField
                label={t('diagnostic.rejectReason')}
                multiline
                value={reason}
                onChange={setReason}
              />
              <div className="row end">
                <Button variant="secondary" onPress={() => setRejecting(false)}>
                  {t('diagnostic.cancel')}
                </Button>
                <Button variant="danger" isDisabled={busy} onPress={() => void reject()}>
                  {t('diagnostic.rejectConfirm')}
                </Button>
              </div>
            </div>
          </Dialog>
        </div>
      ) : null}
    </article>
  );
}

function FamilySection({ group, ...rest }: { group: FamilyGroup } & Omit<CardProps, 'finding'>) {
  const [expanded, setExpanded] = useState(false);
  const headingId = `family-${group.family}`;
  const hidden = Math.max(0, group.findings.length - FAMILY_PAGE_SIZE);
  const shown = expanded ? group.findings : group.findings.slice(0, FAMILY_PAGE_SIZE);
  return (
    <section
      aria-labelledby={headingId}
      className="stack"
      data-testid="family-section"
      data-family={group.family}
    >
      <div className="row row-between">
        <h2 id={headingId} className="h4">
          {t(`diagnostic.family.${group.family}`)}
        </h2>
        <span className="muted small" data-testid="family-count">
          {t('diagnostic.familyCount', { count: group.findings.length })}
        </span>
      </div>
      {group.findings.length === 0 ? (
        <p className="muted small">{t('diagnostic.familyEmpty')}</p>
      ) : (
        <ul className="plain stack">
          {shown.map((finding) => (
            <li key={finding.id}>
              <FindingCard finding={finding} {...rest} />
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 ? (
        <div>
          <Button
            variant="secondary"
            onPress={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            {expanded ? t('diagnostic.showLess') : t('diagnostic.showMore', { count: hidden })}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Page « Diagnostic » (WP-21, maquette `Optimisations.dc.html`, partie diagnostic) : les constats de
 * l'AS-IS validé par famille (gaspillages, flux et délais, organisation, risques et conformité), avec
 * leur justification, leur origine (règle automatique ou IA) et leur localisation sur la cartographie.
 * Chaque constat est une hypothèse que le consultant confirme ou rejette, comme les hypothèses de
 * l'analyse. La page lit le modèle partagé : un constat décidé par un collègue apparaît en direct.
 */
export function DiagnosticPage() {
  const mission = useMission();
  const missionId = mission.id;
  const { canEdit } = useCollab();
  const model = useMissionModel();
  const isValidator = mission.myRole === 'validator';
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [announcement, setAnnouncement] = useState('');
  const reloadRef = useRef<() => Promise<void>>(async () => {});

  const { runs, track } = useGuidedRuns(missionId, WATCHED, ({ run, dto, mine }) => {
    void reloadRef.current();
    if (!mine) return;
    if (run.status === 'failed') {
      showToast({
        tone: 'error',
        title: t('diagnostic.failed'),
        description: t('diagnostic.failedDetail'),
      });
      return;
    }
    showToast({
      tone: 'success',
      title: t('diagnostic.done'),
      description:
        dto?.resultVersion === null || dto === null
          ? undefined
          : t('diagnostic.doneVersion', { version: dto.resultVersion }),
    });
  });

  const reload = useCallback(async () => {
    try {
      const overview = await endpoints.diagnosticOverview(missionId);
      setLoaded({ status: 'ready', overview });
      const last = overview.lastRun;
      if (last !== null && (last.status === 'queued' || last.status === 'running')) {
        track(last.runId, 'diagnostic');
      }
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'PHASE_LOCKED') {
        setLoaded({ status: 'locked' });
        return;
      }
      setLoaded((previous) =>
        previous.status === 'ready' ? previous : { status: 'error', message: errorMessage(error) },
      );
    }
  }, [missionId, track]);
  reloadRef.current = reload;

  useEffect(() => {
    if (isValidator) return;
    void reload();
  }, [isValidator, reload]);

  async function start(): Promise<void> {
    try {
      const started = await endpoints.startDiagnostic(missionId);
      track(started.runId, 'diagnostic');
      showToast({ tone: 'info', title: t('diagnostic.started') });
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }

  async function confirm(finding: Finding): Promise<void> {
    try {
      await endpoints.decideElement(missionId, finding.id, { decision: 'accept' });
      setAnnouncement(t('diagnostic.confirmed', { code: finding.code }));
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }

  async function reject(finding: Finding, reason: string): Promise<void> {
    try {
      await endpoints.decideElement(missionId, finding.id, {
        decision: 'reject',
        ...(reason === '' ? {} : { reason }),
      });
      setAnnouncement(t('diagnostic.rejected', { code: finding.code }));
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }

  if (isValidator) {
    return (
      <div className="stack-lg">
        <h1>{t('diagnostic.heading')}</h1>
        <Notice tone="info">{t('diagnostic.validatorNotice')}</Notice>
      </div>
    );
  }

  if (loaded.status === 'locked') {
    return (
      <div className="stack-lg" data-testid="diagnostic-locked">
        <h1>{t('diagnostic.heading')}</h1>
        <p className="muted">{t('diagnostic.intro')}</p>
        <Notice tone="info" role="status">
          {t('diagnostic.locked')}{' '}
          <Link href={`/missions/${missionId}/validation`}>{t('diagnostic.lockedLink')}</Link>
        </Notice>
      </div>
    );
  }

  const overview = loaded.status === 'ready' ? loaded.overview : null;
  const findings = findingsOf(model);
  const counts = diagnosticCounts(findings);
  const running = activeRun(runs, 'diagnostic');
  const failures = overview?.lastRun?.failures ?? [];
  const groups = groupByFamily(findings);

  return (
    <div className="stack-lg" data-testid="diagnostic-page">
      <div className="stack-sm">
        <h1>{t('diagnostic.heading')}</h1>
        <p className="muted">{t('diagnostic.intro')}</p>
        {overview !== null ? (
          <p className="muted small" data-testid="diagnostic-summary">
            {t('diagnostic.summary', {
              total: counts.total,
              pending: counts.pending,
              confirmed: counts.confirmed,
              macros: overview.macroCount,
            })}
          </p>
        ) : null}
      </div>

      {canEdit ? (
        <div className="stack-sm">
          <div className="row">
            <Button
              isDisabled={running !== null || (overview?.macroCount ?? 0) === 0}
              onPress={() => void start()}
              data-testid="run-diagnostic"
            >
              {counts.total === 0 ? t('diagnostic.run') : t('diagnostic.rerun')}
            </Button>
          </div>
          <p className="muted small">{t('diagnostic.runHelp')}</p>
        </div>
      ) : null}

      {running !== null ? (
        <div role="status" className="stack-sm" data-testid="diagnostic-progress">
          <ProgressMeter
            value={running.progress / 100}
            label={t('diagnostic.progress')}
            valueText={t('diagnostic.progressText', { percent: running.progress })}
          />
        </div>
      ) : null}

      <p role="status" className="small pr-visually-hidden" data-testid="diagnostic-announcement">
        {announcement}
      </p>

      {failures.length > 0 && running === null ? (
        <Notice tone="warning" role="alert">
          <p className="strong">{t('diagnostic.failuresHeading')}</p>
          <ul className="plain">
            {failures.map((failure) => (
              <li key={`${failure.code}-${failure.error}`} data-testid="diagnostic-failure">
                {t('diagnostic.failureItem', { code: failure.code, error: failure.error })}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {loaded.status === 'loading' ? <p role="status">{t('diagnostic.loading')}</p> : null}
      {loaded.status === 'error' ? (
        <Notice tone="danger" role="alert">
          {loaded.message}
        </Notice>
      ) : null}
      {overview !== null && overview.macroCount === 0 ? (
        <Notice tone="info">{t('diagnostic.noScope')}</Notice>
      ) : null}
      {overview !== null && overview.macroCount > 0 && counts.total === 0 && running === null ? (
        <Notice tone="info" role="status">
          {t('diagnostic.empty')}
        </Notice>
      ) : null}

      {model !== null && counts.total > 0
        ? groups.map((group) => (
            <FamilySection
              key={group.family}
              group={group}
              model={model}
              missionId={missionId}
              canEdit={canEdit}
              onConfirm={confirm}
              onReject={reject}
            />
          ))
        : null}
    </div>
  );
}
