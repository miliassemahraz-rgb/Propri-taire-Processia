'use client';

import { t } from '@processia/i18n';
import { useMissionModel } from '../lib/collab';
import { DescriptionEditor } from './description-editor';

/**
 * Espace « Analyse » : à ce stade (WP-10), le texte partagé de la description du métier.
 * WP-13 y ajoute les sources, l'extraction, les écarts et les questions.
 */
export function AnalysisPage() {
  const model = useMissionModel();
  return (
    <div className="stack-lg">
      <div>
        <h1>{t('collab.description.heading')}</h1>
        <p className="muted">{t('collab.description.help')}</p>
      </div>
      <DescriptionEditor />
      <p className="muted small" data-testid="model-version">
        {model === null
          ? t('collab.model.none')
          : t('collab.model.version', { version: model.version })}
      </p>
    </div>
  );
}
