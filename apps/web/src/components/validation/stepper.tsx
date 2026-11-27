'use client';

import { t } from '@processia/i18n';
import type { Step, StepState } from '../../lib/validation';

const STATE_CLASS: Record<StepState, string> = {
  validated: 'step--done',
  pending: 'step--current',
  toSubmit: 'step--todo',
  soon: 'step--todo',
};

/**
 * Étapes de la validation (maquette `Validation.dc.html`) : dossier d'analyse, AS-IS, TO-BE.
 * L'état est écrit en toutes lettres, jamais porté par la seule couleur ; l'étape qui attend une
 * décision porte `aria-current="step"`.
 */
export function ValidationStepper({ steps }: { steps: Step[] }) {
  return (
    <ol aria-label={t('validation.stepper.label')} className="validation-steps">
      {steps.map((step, index) => (
        <li
          key={step.kind}
          className={`validation-step ${STATE_CLASS[step.state]}`}
          aria-current={step.state === 'pending' ? 'step' : undefined}
          data-testid={`step-${step.kind}`}
          data-state={step.state}
        >
          {t('validation.stepper.item', {
            index: index + 1,
            kind: t(`validation.kind.${step.kind}`),
            state: t(`validation.stepper.state.${step.state}`),
          })}
        </li>
      ))}
    </ol>
  );
}
