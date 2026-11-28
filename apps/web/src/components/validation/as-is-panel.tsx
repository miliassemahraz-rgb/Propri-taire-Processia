'use client';

import { t } from '@processia/i18n';
import { DossierPanel, type PanelProps } from './dossier-panel';
import { FrozenMapping } from './frozen-mapping';

const MAPPING_TAB = 'mapping';

/**
 * Panneau d'une soumission `as_is` (WP-21) : le même circuit que le dossier d'analyse (version
 * figée, validation en bloc, fichiers joints, discussion) avec, en premier, la cartographie de la
 * version figée en lecture seule. Valider l'AS-IS ouvre la phase de transformation.
 */
export function AsIsPanel(props: PanelProps) {
  const { missionId, submission, comments, canComment, onChanged } = props;
  return (
    <DossierPanel
      {...props}
      leadingTabs={[
        {
          id: MAPPING_TAB,
          label: t('validation.tabs.mapping'),
          content: (
            <FrozenMapping
              missionId={missionId}
              submission={submission}
              comments={comments}
              canComment={canComment}
              onChanged={onChanged}
            />
          ),
        },
      ]}
    />
  );
}
