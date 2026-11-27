'use client';

import { useEffect, useState } from 'react';
import type { ChunkLocator, ChunkViewDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import { Button, Dialog, Notice } from '@processia/ui';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';

/** Passage à afficher : un morceau de source, avec ou sans passage surligné. */
export interface ViewerTarget {
  sourceId: string;
  title: string;
  /** Identifiant du morceau cité (la référence de source le porte) ; à défaut, `ordinal`. */
  chunkId?: string | undefined;
  ordinal?: number | undefined;
  charStart?: number | undefined;
  charEnd?: number | undefined;
}

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; view: ChunkViewDto };

function locatorText(locator: ChunkLocator | null): string | null {
  if (locator === null) return null;
  switch (locator.kind) {
    case 'page':
      return t('analysis.viewer.page', { number: locator.pageStart });
    case 'paragraph':
      return locator.heading ?? t('analysis.viewer.paragraph', { number: locator.paragraphStart });
    case 'cell':
      return t('analysis.viewer.sheet', { name: locator.sheet });
    case 'line':
      return t('analysis.viewer.line', { number: locator.lineStart });
  }
}

/**
 * Visionneuse de source : affiche le morceau cité avec le passage surligné (`<mark>`, souligné en
 * plus de la couleur), et permet de parcourir les morceaux voisins.
 */
export function SourceViewer({
  missionId,
  target,
  onClose,
}: {
  missionId: string;
  target: ViewerTarget | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  // Morceau affiché : celui de la citation, puis les voisins ; le surlignage ne vaut que pour le premier.
  const [position, setPosition] = useState<{ ordinal: number | null; highlighted: boolean }>({
    ordinal: null,
    highlighted: true,
  });

  useEffect(() => {
    setPosition({ ordinal: target?.ordinal ?? null, highlighted: true });
    setState({ status: 'loading' });
  }, [target]);

  useEffect(() => {
    if (target === null) return;
    let cancelled = false;
    (async () => {
      try {
        let ordinal = position.ordinal;
        if (ordinal === null) {
          // L'ordinal est retrouvé par l'identifiant du morceau cité.
          const chunks = await endpoints.sourceChunks(missionId, target.sourceId);
          const found = chunks.find((chunk) => chunk.id === target.chunkId);
          ordinal = found?.ordinal ?? chunks[0]?.ordinal ?? 0;
        }
        const highlight =
          position.highlighted && target.charStart !== undefined && target.charEnd !== undefined
            ? { charStart: target.charStart, charEnd: target.charEnd }
            : undefined;
        const view = await endpoints.chunkView(missionId, target.sourceId, ordinal, highlight);
        if (!cancelled) setState({ status: 'ready', view });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missionId, target, position]);

  const go = (ordinal: number | null): void => {
    if (ordinal === null) return;
    setState({ status: 'loading' });
    setPosition({ ordinal, highlighted: false });
  };

  return (
    <Dialog
      title={target === null ? '' : t('analysis.viewer.title', { title: target.title })}
      isOpen={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="stack" data-testid="source-viewer">
        {state.status === 'loading' ? <p role="status">{t('analysis.viewer.loading')}</p> : null}
        {state.status === 'error' ? (
          <Notice tone="danger" role="alert">
            {state.message}
          </Notice>
        ) : null}
        {state.status === 'ready' ? (
          <>
            <p className="muted small">
              {t('analysis.viewer.position', { number: state.view.chunk.ordinal + 1 })}
              {locatorText(state.view.chunk.locator) === null
                ? ''
                : ` · ${locatorText(state.view.chunk.locator)}`}
            </p>
            {/* Région défilable : focalisable pour que le clavier puisse la faire défiler (RGAA 7.3). */}
            {/* eslint-disable jsx-a11y/no-noninteractive-tabindex */}
            <div
              className="viewer-text"
              role="region"
              aria-label={t('analysis.viewer.text')}
              tabIndex={0}
            >
              {state.view.highlight === null ? (
                state.view.chunk.text
              ) : (
                <>
                  {state.view.highlight.before}
                  <mark className="viewer-mark" data-testid="viewer-highlight">
                    {state.view.highlight.match}
                  </mark>
                  {state.view.highlight.after}
                </>
              )}
            </div>
            {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
            <div className="row">
              <Button
                variant="secondary"
                isDisabled={state.view.previousOrdinal === null}
                onPress={() => go(state.view.previousOrdinal)}
              >
                {t('analysis.viewer.previous')}
              </Button>
              <Button
                variant="secondary"
                isDisabled={state.view.nextOrdinal === null}
                onPress={() => go(state.view.nextOrdinal)}
              >
                {t('analysis.viewer.next')}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
