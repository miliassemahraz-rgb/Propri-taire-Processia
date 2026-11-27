'use client';

import { useMemo, useState } from 'react';
import type { DecisionRequest } from '@processia/contracts';
import { t } from '@processia/i18n';
import type { BusinessModel, Element } from '@processia/model';
import { Button, ProgressMeter, TextField, showToast } from '@processia/ui';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import {
  activeRun,
  buildCorrection,
  canSummarize,
  correctableFields,
  correctionDefaults,
  elementDetail,
  pendingHypotheses,
  type CorrectionField,
} from '../../lib/guided';
import { useGuidedRuns } from '../../lib/guided-runs';

const WATCHED = ['hypotheses', 'summary'] as const;

export type DecisionOutcome = 'done' | 'already' | 'error';

interface Props {
  missionId: string;
  model: BusinessModel | null;
  canEdit: boolean;
  /** Enregistre la décision du consultant (partagé avec la fiche d'un élément). */
  onDecide: (elementId: string, decision: DecisionRequest) => Promise<DecisionOutcome>;
  onSelectElement: (elementId: string) => void;
}

type Mode = 'idle' | 'correct' | 'reject';
const IDLE: Mode = 'idle';
const CORRECT: Mode = 'correct';
const REJECT: Mode = 'reject';
const REJECTED = 'reject' as const;
const ACCEPT: DecisionRequest = { decision: 'accept' };
const HYPOTHESES = 'hypotheses';
const SUMMARY = 'summary';

function HypothesisCard({
  element,
  canEdit,
  onDecide,
  onSelectElement,
}: {
  element: Element;
  canEdit: boolean;
  onDecide: Props['onDecide'];
  onSelectElement: Props['onSelectElement'];
}) {
  const [mode, setMode] = useState<Mode>(IDLE);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState(() => correctionDefaults(element));
  const [reason, setReason] = useState('');
  const fields = correctableFields(element.kind);
  const detail = elementDetail(element);
  const titleId = `hyp-${element.id}`;

  async function send(decision: DecisionRequest): Promise<void> {
    setBusy(true);
    const outcome = await onDecide(element.id, decision);
    // En cas de succès la carte disparaît de la liste ; sinon elle reste, prête à être reprise.
    if (outcome !== 'done') setBusy(false);
  }

  return (
    <article
      className="card-soft stack"
      aria-labelledby={titleId}
      data-testid="hypothesis-card"
      data-element-code={element.code}
    >
      <div className="row row-between">
        <span className="small strong muted">{t(`analysis.kind.${element.kind}`)}</span>
        <span className="small badge-soft">
          {t(`analysis.origin.${element.provenance.origin}`)}
        </span>
      </div>
      <div className="stack-sm">
        <p id={titleId} className="strong">
          {element.label}
        </p>
        {detail !== '' ? <p className="small">{detail}</p> : null}
      </div>
      <p className="small">
        <span className="strong">{t('analysis.hypotheses.why')} : </span>
        {element.provenance.rationale ?? t('analysis.hypotheses.noRationale')}
      </p>
      <div className="row">
        <Button variant="quiet" onPress={() => onSelectElement(element.id)}>
          {t('analysis.hypotheses.seeElement')}
        </Button>
      </div>
      {!canEdit ? null : mode === IDLE ? (
        <div className="row">
          <Button
            isDisabled={busy}
            aria-label={t('analysis.hypotheses.acceptLabel', { label: element.label })}
            onPress={() => void send(ACCEPT)}
          >
            {t('analysis.hypotheses.accept')}
          </Button>
          {fields.length > 0 ? (
            <Button
              variant="secondary"
              isDisabled={busy}
              aria-label={t('analysis.hypotheses.correctLabel', { label: element.label })}
              onPress={() => setMode(CORRECT)}
            >
              {t('analysis.hypotheses.correct')}
            </Button>
          ) : null}
          <Button
            variant="danger"
            isDisabled={busy}
            aria-label={t('analysis.hypotheses.rejectLabel', { label: element.label })}
            onPress={() => setMode(REJECT)}
          >
            {t('analysis.hypotheses.reject')}
          </Button>
        </div>
      ) : mode === CORRECT ? (
        <form
          className="stack"
          aria-label={t('analysis.hypotheses.correctForm', { label: element.label })}
          onSubmit={(event) => {
            event.preventDefault();
            const correction = buildCorrection(element, values);
            if (Object.keys(correction).length === 0) {
              showToast({ tone: 'info', title: t('analysis.hypotheses.nothingChanged') });
              return;
            }
            void send({ decision: 'correct', correction });
          }}
        >
          <p className="muted small">{t('analysis.hypotheses.correctHelp')}</p>
          {fields.map((field: CorrectionField) => (
            <TextField
              key={field}
              label={t(`analysis.hypotheses.field.${field}`)}
              multiline={field !== 'label'}
              value={values[field]}
              onChange={(value) => setValues((previous) => ({ ...previous, [field]: value }))}
              isDisabled={busy}
            />
          ))}
          <div className="row">
            <Button type="submit" isDisabled={busy}>
              {t('analysis.hypotheses.correctSave')}
            </Button>
            <Button variant="quiet" isDisabled={busy} onPress={() => setMode(IDLE)}>
              {t('analysis.hypotheses.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="stack">
          <p className="small">{t('analysis.hypotheses.rejectHelp')}</p>
          <TextField
            label={t('analysis.hypotheses.reasonLabel')}
            multiline
            value={reason}
            onChange={setReason}
            isDisabled={busy}
          />
          <div className="row">
            <Button
              variant="danger"
              isDisabled={busy}
              onPress={() =>
                void send(
                  reason.trim() === '' ? { decision: REJECTED } : { decision: REJECTED, reason },
                )
              }
            >
              {t('analysis.hypotheses.rejectConfirm')}
            </Button>
            <Button variant="quiet" isDisabled={busy} onPress={() => setMode(IDLE)}>
              {t('analysis.hypotheses.cancel')}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * « Hypothèses à examiner » (WP-14, CDC 3.1) : chaque hypothèse de l'outil (connaissance
 * générale, sans citation) attend la décision du consultant : accepter, corriger ou rejeter.
 * Une hypothèse rejetée est archivée et n'est pas reproposée.
 */
export function HypothesesSection({ missionId, model, canEdit, onDecide, onSelectElement }: Props) {
  const [announcement, setAnnouncement] = useState('');
  const { runs, track } = useGuidedRuns(missionId, WATCHED, ({ run, dto, mine }) => {
    if (!mine) return;
    if (run.status === 'failed') {
      showToast({
        tone: 'error',
        title:
          run.kind === 'summary'
            ? t('analysis.hypotheses.summaryFailed')
            : t('analysis.hypotheses.generateFailed'),
        description: t('analysis.questions.failedDetail'),
      });
      return;
    }
    const changed = dto?.resultVersion !== null && dto !== null;
    showToast({
      tone: 'success',
      title:
        run.kind === 'summary'
          ? t('analysis.hypotheses.summaryDone')
          : t('analysis.hypotheses.generateDone'),
      description: changed
        ? t('analysis.hypotheses.generateVersion', { version: dto.resultVersion ?? 0 })
        : t('analysis.hypotheses.generateNoChange'),
    });
  });

  const hypotheses = useMemo(() => pendingHypotheses(model), [model]);
  const rejected = model?.rejectedHypotheses ?? [];
  const generating = activeRun(runs, 'hypotheses');
  const summarizing = activeRun(runs, 'summary');
  const running = generating ?? summarizing;

  async function start(kind: 'hypotheses' | 'summary'): Promise<void> {
    try {
      const started =
        kind === 'hypotheses'
          ? await endpoints.generateHypotheses(missionId)
          : await endpoints.generateSummary(missionId);
      track(started.runId, kind);
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }

  async function decide(elementId: string, decision: DecisionRequest): Promise<DecisionOutcome> {
    const label = model?.elements[elementId]?.label ?? '';
    const outcome = await onDecide(elementId, decision);
    if (outcome === 'done') {
      setAnnouncement(
        decision.decision === 'reject'
          ? t('analysis.hypotheses.announceRejected', { label })
          : t('analysis.hypotheses.announceConfirmed', { label }),
      );
    } else if (outcome === 'already') {
      setAnnouncement(t('analysis.hypotheses.announceAlready', { label }));
    }
    return outcome;
  }

  return (
    <section
      id="hypotheses"
      aria-labelledby="analysis-hypotheses"
      className="card stack"
      data-testid="hypotheses-section"
    >
      <div className="stack-sm">
        <h2 id="analysis-hypotheses" className="h3">
          {t('analysis.hypotheses.heading')}{' '}
          <span className="muted" data-testid="hypotheses-count">
            {t('analysis.hypotheses.count', { count: hypotheses.length })}
          </span>
        </h2>
        <p className="muted small">{t('analysis.hypotheses.intro')}</p>
      </div>

      {canEdit ? (
        <div className="row">
          <Button
            variant="secondary"
            isDisabled={generating !== null || model === null}
            onPress={() => void start(HYPOTHESES)}
          >
            {t('analysis.hypotheses.generate')}
          </Button>
          <Button
            variant="secondary"
            isDisabled={summarizing !== null || !canSummarize(model)}
            onPress={() => void start(SUMMARY)}
          >
            {t('analysis.hypotheses.summary')}
          </Button>
        </div>
      ) : null}
      {canEdit && !canSummarize(model) ? (
        <p className="muted small">{t('analysis.hypotheses.summaryNeeds')}</p>
      ) : null}
      {running !== null ? (
        <div role="status" className="stack-sm">
          <ProgressMeter
            value={running.progress / 100}
            label={t('analysis.hypotheses.progress')}
            valueText={t('analysis.analyze.progressText', { percent: running.progress })}
          />
        </div>
      ) : null}

      <p role="status" className="small" data-testid="hypotheses-announcement">
        {announcement}
      </p>

      {model === null ? (
        <p className="muted">{t('analysis.concepts.noModel')}</p>
      ) : hypotheses.length === 0 ? (
        <p className="muted" data-testid="hypotheses-empty">
          {t('analysis.hypotheses.none')}
        </p>
      ) : (
        <div className="stack">
          {hypotheses.map((element) => (
            <HypothesisCard
              key={element.id}
              element={element}
              canEdit={canEdit}
              onDecide={decide}
              onSelectElement={onSelectElement}
            />
          ))}
        </div>
      )}

      {rejected.length > 0 ? (
        <details className="stack-sm" data-testid="hypotheses-archive">
          <summary>{t('analysis.hypotheses.archive', { count: rejected.length })}</summary>
          <p className="muted small">{t('analysis.hypotheses.archiveHelp')}</p>
          <ul className="plain stack-sm">
            {rejected.map((entry) => (
              <li key={entry.element.id} className="small">
                <span className="strong">{entry.element.label}</span>
                {' · '}
                {t(`analysis.kind.${entry.element.kind}`)}
                {' · '}
                {t('analysis.hypotheses.rejectedOn', { date: formatDate(entry.at) })}
                {entry.reason === undefined
                  ? ''
                  : ` · ${t('analysis.hypotheses.rejectedReason', { reason: entry.reason })}`}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
