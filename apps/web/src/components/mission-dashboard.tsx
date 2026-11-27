'use client';

import { useEffect, useState } from 'react';
import type { MissionPhase } from '@processia/contracts';
import { t, type MessageKey } from '@processia/i18n';
import {
  BusinessModelSchema,
  CONCEPTS,
  completeness,
  type CompletenessByConcept,
  type Concept,
} from '@processia/model';
import { Notice, ProgressMeter } from '@processia/ui';
import { endpoints } from '../lib/endpoints';
import { ApiRequestError } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { useMode } from '../lib/mode';
import { useMission } from './mission-frame';

const STEPS: { key: MessageKey }[] = [
  { key: 'dashboard.steps.analysis' },
  { key: 'dashboard.steps.dossierValidation' },
  { key: 'dashboard.steps.asIs' },
  { key: 'dashboard.steps.asIsValidation' },
  { key: 'dashboard.steps.toBe' },
  { key: 'dashboard.steps.toBeValidation' },
];

/** Étape en cours selon la phase de la mission (les étapes précédentes sont terminées). */
const CURRENT_STEP: Record<MissionPhase, number> = {
  analysis: 0,
  mapping: 2,
  transformation: 4,
  generation: 5,
};

const MAX_GAPS_SHOWN = 6;

type ModelState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }
  | { status: 'ready'; report: CompletenessByConcept };

function stepState(index: number, current: number): 'done' | 'current' | 'upcoming' {
  if (index < current) return 'done';
  return index === current ? 'current' : 'upcoming';
}

function Steps({ phase }: { phase: MissionPhase }) {
  const current = CURRENT_STEP[phase];
  return (
    <ol className="steps">
      {STEPS.map((step, index) => {
        const state = stepState(index, current);
        return (
          <li
            key={step.key}
            className={`step step--${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <div className="step-state">{t(`dashboard.state.${state}`)}</div>
            <div className="step-name">{t(step.key)}</div>
          </li>
        );
      })}
    </ol>
  );
}

function ConceptList({ report }: { report: CompletenessByConcept }) {
  const [open, setOpen] = useState<Concept | null>(null);
  return (
    <ul className="concepts">
      {CONCEPTS.map((concept) => {
        const entry = report[concept];
        const percent = Math.round(entry.score * 100);
        const isOpen = open === concept;
        const gaps = entry.gaps.slice(0, MAX_GAPS_SHOWN).map((gap) => gap.message);
        return (
          <li key={concept}>
            <button
              type="button"
              className="concept-button"
              aria-expanded={isOpen}
              aria-controls={`gaps-${concept}`}
              onClick={() => setOpen(isOpen ? null : concept)}
            >
              <span className="concept-name">{t(`dashboard.concepts.${concept}`)}</span>
              <span className="concept-bar" aria-hidden="true">
                <span style={{ width: `${percent}%` }} />
              </span>
              <span className="concept-pct">{t('format.percent', { value: percent })}</span>
            </button>
            {isOpen ? (
              <div id={`gaps-${concept}`} className="concept-gaps">
                {gaps.length === 0 ? (
                  t('dashboard.nothingMissing')
                ) : (
                  <>
                    <strong>{t('dashboard.missing')}</strong> {gaps.join(' ; ')}
                  </>
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function MissionDashboard() {
  const mission = useMission();
  const { mode } = useMode();
  const [model, setModel] = useState<ModelState>({ status: 'loading' });

  useEffect(() => {
    // Un validateur n'a pas accès à l'espace de travail : pas d'avancement du modèle.
    if (mission.progress === null) {
      setModel({ status: 'unavailable' });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const head = await endpoints.headModel(mission.id);
        if (cancelled) return;
        if (head.version === 0) {
          setModel({ status: 'none' });
          return;
        }
        const parsed = BusinessModelSchema.parse(head.model);
        setModel({ status: 'ready', report: completeness(parsed) });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiRequestError && error.code === 'FORBIDDEN') {
          setModel({ status: 'unavailable' });
        } else {
          setModel({ status: 'error', message: errorMessage(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mission.id, mission.progress]);

  const report = model.status === 'ready' ? model.report : null;
  const hypotheses = report ? CONCEPTS.reduce((sum, c) => sum + report[c].pendingHypotheses, 0) : 0;
  const questions = report ? CONCEPTS.reduce((sum, c) => sum + report[c].openQuestions, 0) : 0;
  const pending = mission.progress?.pendingSubmissions ?? 0;
  const todo: string[] = [];
  if (hypotheses > 0) todo.push(t('dashboard.hypotheses', { count: hypotheses }));
  if (questions > 0) todo.push(t('dashboard.questions', { count: questions }));
  if (pending > 0) todo.push(t('dashboard.pending', { count: pending }));

  return (
    <div className="stack-lg">
      <h1>{t('dashboard.heading')}</h1>
      <section aria-labelledby="t-steps" className="stack">
        <h2 id="t-steps">{t('dashboard.stepsHeading')}</h2>
        <Steps phase={mission.phase} />
      </section>

      <div className="grid-2">
        <section aria-labelledby="t-completeness" className="card stack">
          <h2 id="t-completeness" className="h3">
            {t('dashboard.completenessHeading')}
          </h2>
          {model.status === 'loading' ? <p role="status">{t('ui.loading')}</p> : null}
          {model.status === 'none' ? (
            <Notice tone="info">{t('dashboard.noModelYet')}</Notice>
          ) : null}
          {model.status === 'unavailable' ? (
            <Notice tone="info">{t('dashboard.modelUnavailable')}</Notice>
          ) : null}
          {model.status === 'error' ? (
            <Notice tone="danger" role="alert">
              {model.message}
            </Notice>
          ) : null}
          {report ? (
            <>
              <p className="muted small">{t('dashboard.completenessHint')}</p>
              {mission.progress?.completeness !== null &&
              mission.progress?.completeness !== undefined ? (
                <ProgressMeter
                  value={mission.progress.completeness}
                  label={t('dashboard.global')}
                  valueText={t('format.percent', {
                    value: Math.round(mission.progress.completeness * 100),
                  })}
                />
              ) : null}
              <ConceptList report={report} />
            </>
          ) : null}
        </section>

        <div className="stack">
          <section aria-labelledby="t-todo" className="card stack">
            <h2 id="t-todo" className="h3">
              {t('dashboard.todoHeading')}
            </h2>
            {todo.length === 0 ? (
              <p className="muted">{t('dashboard.nothingTodo')}</p>
            ) : (
              <ul className="todo">
                {todo.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            <h2 className="h3">{t('dashboard.activityHeading')}</h2>
            <p className="muted">{t('dashboard.activityEmpty')}</p>
          </section>
          {mode === 'expert' ? (
            <section className="card stack small" aria-label={t('shell.mode.expert')}>
              <p>{t('dashboard.expert.head', { version: mission.headVersion })}</p>
              <p>{t('dashboard.expert.client', { id: mission.clientId })}</p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
