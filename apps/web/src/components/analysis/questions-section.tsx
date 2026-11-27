'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { QuestionDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import { completeness, overallCompleteness, type BusinessModel } from '@processia/model';
import { Button, Notice, ProgressMeter, TextField, showToast } from '@processia/ui';
import { ApiRequestError } from '../../lib/api';
import { useMissionEvents } from '../../lib/collab';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';
import { activeRun, blockingConcepts, openQuestions } from '../../lib/guided';
import { useGuidedRuns } from '../../lib/guided-runs';

const WATCHED = ['questions', 'answer'] as const;

interface Props {
  missionId: string;
  model: BusinessModel | null;
  canEdit: boolean;
  /** Ouvre l'élément dans la fiche de l'espace Analyse. */
  onSelectElement: (elementId: string) => void;
}

/**
 * « Questions de l'outil » (WP-14, CDC 3.2) : une question à la fois, la plus bloquante d'abord ;
 * le consultant répond, passe, ou arrête le questionnement quand il estime en savoir assez.
 */
export function QuestionsSection({ missionId, model, canEdit, onSelectElement }: Props) {
  const [questions, setQuestions] = useState<QuestionDto[] | null>(null);
  const [answer, setAnswer] = useState('');
  const [pending, setPending] = useState(false);
  const [stopped, setStopped] = useState(false);

  const reload = useCallback(async () => {
    try {
      setQuestions(await endpoints.listQuestions(missionId));
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.code === 'FORBIDDEN')) {
        showToast({ tone: 'error', title: errorMessage(error) });
      }
    }
  }, [missionId]);

  useEffect(() => {
    void reload();
  }, [reload, model?.version]);

  // Un autre consultant répond, passe ou arrête : la liste se met à jour sans rechargement.
  useMissionEvents((message) => {
    if (message.type === 'question.updated') void reload();
  });

  const { runs, track } = useGuidedRuns(missionId, WATCHED, ({ run, dto, mine }) => {
    void reload();
    if (!mine) return;
    if (run.status === 'failed') {
      showToast({
        tone: 'error',
        title:
          run.kind === 'answer'
            ? t('analysis.questions.answerFailed')
            : t('analysis.questions.generateFailed'),
        description: t('analysis.questions.failedDetail'),
      });
    } else if (run.kind === 'answer') {
      showToast({
        tone: 'success',
        title: t('analysis.questions.answerDone'),
        description:
          dto?.resultVersion === null || dto === null
            ? t('analysis.questions.answerNoChange')
            : t('analysis.questions.answerVersion', { version: dto.resultVersion }),
      });
    } else {
      showToast({ tone: 'success', title: t('analysis.questions.generateDone') });
    }
  });

  const open = useMemo(() => openQuestions(questions ?? []), [questions]);
  const current = open[0] ?? null;
  const treated = (questions ?? []).filter((q) => q.status !== 'open');
  const generating = activeRun(runs, 'questions');
  const integrating = activeRun(runs, 'answer');
  const overall = useMemo(
    () => (model === null ? 0 : Math.round(overallCompleteness(completeness(model)) * 100)),
    [model],
  );

  // Une nouvelle question : le champ de réponse repart vide.
  const currentId = current?.id ?? null;
  useEffect(() => {
    setAnswer('');
  }, [currentId]);

  async function generate(): Promise<void> {
    try {
      setStopped(false);
      const started = await endpoints.generateQuestions(missionId);
      track(started.runId, 'questions');
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }

  async function submit(question: QuestionDto): Promise<void> {
    setPending(true);
    try {
      const result = await endpoints.answerQuestion(missionId, question.id, answer);
      track(result.runId, 'answer', result.source.id);
      setAnswer('');
      await reload();
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
      await reload();
    } finally {
      setPending(false);
    }
  }

  async function skip(question: QuestionDto): Promise<void> {
    setPending(true);
    try {
      await endpoints.skipQuestion(missionId, question.id);
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setPending(false);
      await reload();
    }
  }

  async function stop(): Promise<void> {
    setPending(true);
    try {
      await endpoints.stopQuestions(missionId);
      setStopped(true);
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setPending(false);
      await reload();
    }
  }

  const conceptNames = (question: QuestionDto): string =>
    blockingConcepts(question, model)
      .map((concept) => t(`dashboard.concepts.${concept}`))
      .join(', ');

  return (
    <section
      id="questions"
      aria-labelledby="analysis-questions"
      className="card stack"
      data-testid="questions-section"
    >
      <div className="stack-sm">
        <h2 id="analysis-questions" className="h3">
          {t('analysis.questions.heading')}{' '}
          <span className="muted" data-testid="questions-count">
            {t('analysis.questions.count', { count: open.length })}
          </span>
        </h2>
        <p className="muted small">{t('analysis.questions.intro')}</p>
      </div>

      <div className="stack-sm" data-testid="questions-completeness">
        <ProgressMeter
          value={overall / 100}
          label={t('analysis.questions.completenessLabel')}
          valueText={t('analysis.questions.completenessText', { percent: overall })}
        />
        <p className="muted small">{t('analysis.questions.completenessHelp')}</p>
      </div>

      {generating !== null ? (
        <p role="status" className="muted">
          {t('analysis.questions.generating')}
        </p>
      ) : null}
      {integrating !== null ? (
        <p role="status" className="muted" data-testid="answer-integrating">
          {t('analysis.questions.integrating')}
        </p>
      ) : null}

      {questions === null ? (
        <p className="muted">{t('analysis.questions.loading')}</p>
      ) : current === null ? (
        <div className="stack">
          {stopped ? (
            <Notice tone="info" role="status">
              {t('analysis.questions.stopped')}
            </Notice>
          ) : (
            <p className="muted" data-testid="questions-empty">
              {questions.length === 0
                ? t('analysis.questions.none')
                : t('analysis.questions.allDone')}
            </p>
          )}
          {canEdit ? (
            <div className="row">
              <Button isDisabled={generating !== null} onPress={() => void generate()}>
                {t('analysis.questions.generate')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <article
          className="stack card-soft"
          aria-labelledby="current-question"
          data-testid="current-question"
        >
          <p className="muted small" data-testid="question-blocking">
            {t('analysis.questions.blocking', { concepts: conceptNames(current) })}
            {current.blockingScore === null
              ? ''
              : ` · ${t('analysis.questions.score', { score: Math.round(current.blockingScore) })}`}
          </p>
          <p id="current-question" className="strong">
            {current.text}
          </p>
          {current.rationale !== null ? (
            <p className="small">
              <span className="strong">{t('analysis.questions.why')} : </span>
              {current.rationale}
            </p>
          ) : null}
          {current.targetElementIds.length > 0 ? (
            <div className="small stack-sm">
              <span className="strong">{t('analysis.questions.targets')} : </span>
              <ul className="plain row">
                {current.targetElementIds.map((id) => {
                  const element = model?.elements[id];
                  return element === undefined ? null : (
                    <li key={id}>
                      <Button variant="quiet" onPress={() => onSelectElement(id)}>
                        {`${element.code} ${element.label}`}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {canEdit ? (
            <>
              <TextField
                label={t('analysis.questions.answerLabel')}
                multiline
                value={answer}
                onChange={setAnswer}
                isDisabled={pending}
              />
              <div className="row">
                <Button
                  isDisabled={pending || answer.trim() === ''}
                  onPress={() => void submit(current)}
                >
                  {t('analysis.questions.answer')}
                </Button>
                <Button variant="secondary" isDisabled={pending} onPress={() => void skip(current)}>
                  {t('analysis.questions.skip')}
                </Button>
                <Button variant="quiet" isDisabled={pending} onPress={() => void stop()}>
                  {t('analysis.questions.stop')}
                </Button>
              </div>
              <p className="muted small">
                {t('analysis.questions.remaining', { count: open.length - 1 })}
              </p>
            </>
          ) : (
            <p className="muted small">{t('analysis.questions.readOnly')}</p>
          )}
        </article>
      )}

      {treated.length > 0 ? (
        <details className="stack-sm" data-testid="questions-treated">
          <summary>{t('analysis.questions.treated', { count: treated.length })}</summary>
          <ul className="plain stack-sm">
            {treated.map((question) => (
              <li key={question.id} className="small">
                <span className="strong">
                  {t(`analysis.questions.status.${question.status}`)} :{' '}
                </span>
                {question.text}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
