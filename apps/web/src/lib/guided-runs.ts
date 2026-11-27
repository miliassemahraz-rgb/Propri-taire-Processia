'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuidedRunKind, RunDto } from '@processia/contracts';
import { useMissionEvents } from './collab';
import { endpoints } from './endpoints';
import { applyGuidedRun, isRunActive, type GuidedRunState } from './guided';

const POLL_MS = 1500;

export interface FinishedRun {
  run: GuidedRunState;
  /** Détail de l'exécution (version produite), `null` si la lecture a échoué. */
  dto: RunDto | null;
  /** Lancée depuis cet écran (et non par un autre consultant). */
  mine: boolean;
}

/**
 * Suit les exécutions du questionnement guidé (`run.progress` du serveur de coédition, avec
 * repli par interrogation de `GET runs/:runId`), et signale la fin de chacune une seule fois.
 */
export function useGuidedRuns(
  missionId: string,
  kinds: readonly GuidedRunKind[],
  onFinished: (finished: FinishedRun) => void,
) {
  const [runs, setRuns] = useState<Record<string, GuidedRunState>>({});
  const mine = useRef(new Set<string>());
  const reported = useRef(new Set<string>());
  const latest = useRef(onFinished);
  latest.current = onFinished;
  const watched = useRef(kinds);
  watched.current = kinds;

  useMissionEvents((message) => {
    if (message.type !== 'run.progress') return;
    setRuns((previous) => applyGuidedRun(previous, message, watched.current));
  });

  /** À appeler juste après le lancement d'une exécution depuis cet écran. */
  const track = useCallback(
    (runId: string, kind: GuidedRunKind, sourceId: string | null = null) => {
      mine.current.add(runId);
      setRuns((previous) =>
        previous[runId] === undefined
          ? {
              ...previous,
              [runId]: { runId, kind, status: 'queued', progress: 0, error: null, sourceId },
            }
          : previous,
      );
    },
    [],
  );

  const activeIds = Object.values(runs)
    .filter(isRunActive)
    .map((run) => run.runId)
    .join(',');
  useEffect(() => {
    if (activeIds === '') return;
    const ids = activeIds.split(',');
    const timer = setInterval(() => {
      for (const id of ids) {
        void endpoints
          .getRun(missionId, id)
          .then((dto) =>
            setRuns((previous) => {
              const current = previous[id];
              if (current === undefined) return previous;
              return applyGuidedRun(
                previous,
                {
                  type: 'run.progress',
                  missionId,
                  runId: id,
                  kind: dto.kind,
                  status: dto.status,
                  progress: dto.progress,
                  sourceId: current.sourceId,
                  error: dto.error,
                },
                watched.current,
              );
            }),
          )
          .catch(() => undefined);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [missionId, activeIds]);

  useEffect(() => {
    for (const run of Object.values(runs)) {
      if (isRunActive(run) || reported.current.has(run.runId)) continue;
      reported.current.add(run.runId);
      const isMine = mine.current.has(run.runId);
      void endpoints
        .getRun(missionId, run.runId)
        .then(
          (dto) => dto,
          () => null,
        )
        .then((dto) => latest.current({ run, dto, mine: isMine }));
    }
  }, [runs, missionId]);

  return { runs, track };
}
