'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExportArtifactDto, ExportFormat } from '@processia/contracts';
import { t } from '@processia/i18n';
import { Button, DataTable, ProgressMeter, showToast } from '@processia/ui';
import { useMissionEvents } from '../../lib/collab';
import {
  busyFormats,
  EXPORT_FORMATS_ORDER,
  isExportActive,
  mergeExportRun,
  shortSha,
  type ExportRunState,
} from '../../lib/deliverables';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { useMode } from '../../lib/mode';

const POLL_MS = 1000;

const formatName = (format: ExportFormat): string => t(`deliverables.export.formats.${format}`);

/** Lance le téléchargement d'une URL présignée (le serveur impose `Content-Disposition`). */
function startDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

interface Props {
  missionId: string;
  /** Version du modèle présentée : celle que les exports reprendront. */
  version: number | null;
}

/**
 * Exports du dossier d'analyse : un bouton par format (tâche asynchrone du worker, suivie par
 * `run.progress`), puis la liste des fichiers produits, liés à leur version et à leur empreinte.
 */
export function ExportPanel({ missionId, version }: Props) {
  const { mode } = useMode();
  const [files, setFiles] = useState<ExportArtifactDto[] | null>(null);
  const [runs, setRuns] = useState<Record<string, ExportRunState>>({});

  const refresh = useCallback(async () => {
    try {
      setFiles(await endpoints.listExports(missionId));
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }, [missionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Un autre consultant termine un export : la liste se met à jour sans rechargement.
  useMissionEvents((message) => {
    if (message.type === 'run.progress' && message.kind === 'export') {
      setRuns((previous) => mergeExportRun(previous, message));
      if (message.status === 'succeeded') void refresh();
    }
  });

  const activeIds = Object.values(runs)
    .filter(isExportActive)
    .map((run) => run.runId)
    .join(',');
  useEffect(() => {
    if (activeIds === '') return;
    const timer = setInterval(() => {
      for (const id of activeIds.split(',')) {
        void endpoints
          .getRun(missionId, id)
          .then((dto) => setRuns((previous) => mergeExportRun(previous, { runId: id, ...dto })))
          .catch(() => undefined);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [missionId, activeIds]);

  // Fin d'un export lancé ici : message et liste à jour (une seule fois par exécution).
  const finished = Object.values(runs)
    .filter((run) => !isExportActive(run))
    .map((run) => `${run.runId}:${run.status}:${run.format}`)
    .join(',');
  const reported = useRef(new Set<string>());
  useEffect(() => {
    for (const entry of finished === '' ? [] : finished.split(',')) {
      if (reported.current.has(entry)) continue;
      reported.current.add(entry);
      const [runId, status, format] = entry.split(':') as [string, string, ExportFormat];
      void refresh();
      if (status === 'failed') {
        showToast({
          tone: 'error',
          title: t('deliverables.export.failed', { format: formatName(format) }),
        });
        continue;
      }
      void endpoints
        .getRun(missionId, runId)
        .then((dto) =>
          showToast({
            tone: 'success',
            title: t('deliverables.export.done', { format: formatName(format) }),
            description:
              dto.resultVersion === null
                ? undefined
                : t('deliverables.export.doneDetail', { version: dto.resultVersion }),
          }),
        )
        .catch(() =>
          showToast({
            tone: 'success',
            title: t('deliverables.export.done', { format: formatName(format) }),
          }),
        );
    }
  }, [finished, missionId, refresh]);

  async function start(format: ExportFormat): Promise<void> {
    try {
      const started = await endpoints.startExport(missionId, format);
      setRuns((previous) => ({
        ...previous,
        [started.runId]: { runId: started.runId, format, status: 'queued', progress: 0 },
      }));
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }

  async function download(file: ExportArtifactDto): Promise<void> {
    try {
      const link = await endpoints.exportDownloadUrl(missionId, file.id);
      startDownload(link.url, link.filename);
    } catch (error) {
      showToast({
        tone: 'error',
        title: t('deliverables.files.downloadFailed'),
        description: errorMessage(error),
      });
    }
  }

  const busy = busyFormats(runs);
  const active = Object.values(runs).filter(isExportActive);

  return (
    <section aria-labelledby="deliverables-export" className="card stack">
      <div className="stack-sm">
        <h2 id="deliverables-export" className="h3">
          {t('deliverables.export.heading')}
        </h2>
        <p className="muted small">{t('deliverables.export.help')}</p>
      </div>
      <div className="row">
        {EXPORT_FORMATS_ORDER.map((format) => (
          <Button
            key={format}
            variant="secondary"
            isDisabled={busy.has(format) || version === null}
            onPress={() => void start(format)}
          >
            {t('deliverables.export.button', { format: formatName(format) })}
          </Button>
        ))}
      </div>
      {active.map((run) => (
        <div key={run.runId} className="stack-sm" data-testid="export-progress">
          <p role="status" className="muted small">
            {t('deliverables.export.running', { format: formatName(run.format) })}
          </p>
          <ProgressMeter
            value={run.progress / 100}
            label={t('deliverables.export.progressLabel', { format: formatName(run.format) })}
            valueText={t('deliverables.export.progressText', { percent: run.progress })}
          />
        </div>
      ))}

      <div className="stack-sm">
        <h3 className="h4">{t('deliverables.files.heading')}</h3>
        {files === null ? <p role="status">{t('ui.loading')}</p> : null}
        {files !== null && files.length === 0 ? (
          <p className="muted">{t('deliverables.files.empty')}</p>
        ) : null}
        {files !== null && files.length > 0 ? (
          <DataTable caption={t('deliverables.files.table')}>
            <thead>
              <tr>
                <th scope="col">{t('deliverables.files.format')}</th>
                <th scope="col">{t('deliverables.files.version')}</th>
                <th scope="col">{t('deliverables.files.date')}</th>
                <th scope="col">{t('deliverables.files.sha')}</th>
                <th scope="col">{t('deliverables.files.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id} data-testid="export-file">
                  <th scope="row">{formatName(file.format)}</th>
                  <td>{file.modelVersion}</td>
                  <td>{formatDateTime(file.createdAt)}</td>
                  <td>
                    <code className="break-all" title={file.sha256}>
                      {mode === 'expert' ? file.sha256 : shortSha(file.sha256)}
                    </code>
                  </td>
                  <td>
                    <Button
                      variant="quiet"
                      aria-label={t('deliverables.files.downloadLabel', {
                        filename: file.filename,
                      })}
                      onPress={() => void download(file)}
                    >
                      {t('deliverables.files.download')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : null}
      </div>
    </section>
  );
}
