'use client';

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import type { CommentDto, NoticeDto, SubmissionDto, SubmissionKind } from '@processia/contracts';
import { t } from '@processia/i18n';
import { Notice, Select } from '@processia/ui';
import { useMissionEvents } from '../lib/collab';
import { endpoints } from '../lib/endpoints';
import { errorMessage } from '../lib/errors';
import { defaultSubmission, latestOf, validationSteps } from '../lib/validation';
import { useMission } from './mission-frame';
import { DossierPanel, type PanelProps } from './validation/dossier-panel';
import { NoticesPanel } from './validation/notices-panel';
import { ValidationStepper } from './validation/stepper';

const POLL_MS = 5000;

/**
 * Panneau par type de soumission. Le dossier d'analyse est complet ; l'AS-IS (WP-21) et le TO-BE
 * (WP-23, décision optimisation par optimisation) brancheront ici leur propre panneau, avec le
 * même contrat `PanelProps`, sans toucher au portail.
 */
function PendingPanel({ submission }: PanelProps) {
  return (
    <Notice tone="info">
      {submission.kind === 'as_is' ? t('validation.panel.asIs') : t('validation.panel.toBe')}
    </Notice>
  );
}

export const PANELS: Record<SubmissionKind, ComponentType<PanelProps>> = {
  analysis_dossier: DossierPanel,
  as_is: PendingPanel,
  to_be: PendingPanel,
};

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      submissions: SubmissionDto[];
      comments: CommentDto[];
      notices: NoticeDto[];
    };

/**
 * Portail du validateur et suivi des soumissions (WP-16, maquette `Validation.dc.html`) :
 * étapes de la validation, lecture seule de la version figée, commentaires, décision du
 * validateur (« Valider le dossier » avec confirmation), fichiers joints et signalements après
 * validation. Le consultant y retrouve ses soumissions, les hypothèses exclues et la discussion.
 *
 * Le validateur n'utilise pas Yjs : la page se met à jour par relecture régulière ; les
 * consultants reçoivent en plus les messages `comment.created` et `submission.updated`.
 */
export function ValidationPage() {
  const mission = useMission();
  const missionId = mission.id;
  const isValidator = mission.myRole === 'validator';
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [submissions, comments, notices] = await Promise.all([
        endpoints.listSubmissions(missionId),
        endpoints.listComments(missionId),
        endpoints.listNotices(missionId),
      ]);
      setLoaded({ status: 'ready', submissions, comments, notices });
    } catch (error) {
      setLoaded((previous) =>
        previous.status === 'ready' ? previous : { status: 'error', message: errorMessage(error) },
      );
    }
  }, [missionId]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  useMissionEvents((message) => {
    if (
      message.type === 'comment.created' ||
      message.type === 'submission.updated' ||
      message.type === 'notice.created'
    ) {
      void reload();
    }
  });

  const submissions = loaded.status === 'ready' ? loaded.submissions : null;
  const steps = useMemo(() => validationSteps(submissions ?? []), [submissions]);
  const selected = useMemo(() => {
    if (submissions === null) return null;
    return (
      submissions.find((s) => s.id === selectedId && s.status !== 'withdrawn') ??
      defaultSubmission(submissions)
    );
  }, [submissions, selectedId]);

  const heading = isValidator ? t('validation.validatorHeading') : t('validation.heading');
  const visible = (submissions ?? []).filter((s) => s.status !== 'withdrawn');
  const Panel = selected === null ? null : PANELS[selected.kind];
  const latestId =
    selected === null ? null : (latestOf(submissions ?? [], selected.kind)?.id ?? null);

  return (
    <div className="stack-lg validation" data-testid="validation-page">
      <div className="stack-sm">
        {isValidator ? <p className="portal-kicker">{t('validation.portalBrand')}</p> : null}
        <h1>{heading}</h1>
        <p className="muted">
          {isValidator ? t('validation.introValidator') : t('validation.introTeam')}
        </p>
      </div>

      <ValidationStepper steps={steps} />

      {loaded.status === 'loading' ? <p role="status">{t('validation.loading')}</p> : null}
      {loaded.status === 'error' ? (
        <Notice tone="danger" role="alert">
          {loaded.message}
        </Notice>
      ) : null}

      {loaded.status === 'ready' && selected === null ? (
        <Notice tone="info">
          {isValidator ? t('validation.noSubmission.validator') : t('validation.noSubmission.team')}
        </Notice>
      ) : null}

      {visible.length > 1 && selected !== null ? (
        <Select
          label={t('validation.submissions.select')}
          value={selected.id}
          onChange={setSelectedId}
          placeholder={t('validation.submissions.select')}
          options={visible.map((s) => ({
            id: s.id,
            label: t('validation.submissions.option', {
              round: s.round,
              version: s.modelVersion,
              status: t(`validation.status.${s.status}`),
            }),
          }))}
        />
      ) : null}

      {Panel !== null && selected !== null && loaded.status === 'ready' ? (
        <Panel
          key={selected.id}
          missionId={missionId}
          submission={selected}
          comments={loaded.comments}
          isValidator={isValidator}
          canComment={selected.status === 'submitted' || selected.status === 'validated'}
          onChanged={() => void reload()}
          latestId={latestId}
          onSelect={setSelectedId}
        />
      ) : null}

      {loaded.status === 'ready' &&
      (loaded.notices.length > 0 || steps[0]?.state === 'validated') ? (
        <NoticesPanel
          missionId={missionId}
          notices={loaded.notices}
          canMarkSeen={isValidator}
          onChanged={() => void reload()}
        />
      ) : null}
    </div>
  );
}
