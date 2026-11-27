'use client';

import { t } from '@processia/i18n';
import type { ElementStatus } from '@processia/model';
import { StatusBadge, type BadgeTone } from '@processia/ui';

const TONE: Record<ElementStatus, BadgeTone> = {
  extracted: 'info',
  hypothesis: 'warning',
  confirmed: 'success',
  validated: 'success',
};

/**
 * Badge de statut d'un élément : une icône ET le texte, jamais la couleur seule. L'infobulle
 * (`title`) rappelle ce que le statut implique pour les livrables.
 */
export function ElementStatusBadge({ status }: { status: ElementStatus }) {
  return (
    <span title={t(`analysis.statusHint.${status}`)}>
      <StatusBadge tone={TONE[status]}>
        <span aria-hidden="true">{t(`analysis.statusIcon.${status}`)} </span>
        {t(`analysis.status.${status}`)}
      </StatusBadge>
    </span>
  );
}
