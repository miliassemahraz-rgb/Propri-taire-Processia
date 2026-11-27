'use client';

import { useCallback, useEffect, useState } from 'react';
import type { VersionSummary } from '@processia/contracts';
import { t } from '@processia/i18n';
import {
  CHANGE_CAUSES,
  type BusinessModel,
  type ChangeCause,
  type ModelDiff,
} from '@processia/model';
import { Button, Dialog, Notice, showToast } from '@processia/ui';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';

const MAX_LISTED = 8;

function causeLabel(cause: string): string {
  return (CHANGE_CAUSES as readonly string[]).includes(cause)
    ? t(`analysis.history.cause.${cause as ChangeCause}`)
    : cause;
}

interface Changes {
  diff: ModelDiff;
  labels: Map<string, string>;
}

type ChangesState = { status: 'loading' } | { status: 'ready'; changes: Changes };

function labelList(ids: string[], labels: Map<string, string>): string {
  const names = ids.slice(0, MAX_LISTED).map((id) => labels.get(id) ?? id);
  const rest = ids.length - MAX_LISTED;
  return rest > 0
    ? `${names.join(', ')} ${t('analysis.history.moreElements', { count: rest })}`
    : names.join(', ');
}

function ChangesView({ version, changes }: { version: number; changes: Changes }) {
  const { diff, labels } = changes;
  const modified = diff.modified.map((entry) => entry.id);
  const empty = diff.added.length === 0 && modified.length === 0 && diff.removed.length === 0;
  const groups = [
    { key: 'added', title: t('analysis.history.addedList'), ids: diff.added },
    { key: 'modified', title: t('analysis.history.modifiedList'), ids: modified },
    { key: 'removed', title: t('analysis.history.removedList'), ids: diff.removed },
  ].filter((group) => group.ids.length > 0);
  return (
    <div
      className="stack-sm changes"
      role="group"
      aria-label={t('analysis.history.changes', { version })}
    >
      <p className="small strong">
        {[
          t('analysis.history.added', { count: diff.added.length }),
          t('analysis.history.modified', { count: modified.length }),
          t('analysis.history.removed', { count: diff.removed.length }),
        ].join(' · ')}
      </p>
      {empty ? <p className="muted small">{t('analysis.history.noChange')}</p> : null}
      {groups.map((group) => (
        <p key={group.key} className="small">
          <span className="strong">{group.title} : </span>
          {labelList(group.ids, labels)}
        </p>
      ))}
    </div>
  );
}

interface Props {
  missionId: string;
  /** Version de tête du modèle partagé : toute nouvelle version recharge la liste. */
  headVersion: number | null;
  selfId: string;
  canRollback: boolean;
}

/** Historique des versions : liste, différences d'une version, retour arrière (nouvelle version). */
export function HistorySection({ missionId, headVersion, selfId, canRollback }: Props) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [changes, setChanges] = useState<ChangesState>({ status: 'loading' });
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setVersions(await endpoints.listVersions(missionId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [missionId]);

  useEffect(() => {
    void load();
  }, [load, headVersion]);

  async function toggle(entry: VersionSummary): Promise<void> {
    if (open === entry.version) {
      setOpen(null);
      return;
    }
    setOpen(entry.version);
    setChanges({ status: 'loading' });
    try {
      const from = entry.parentVersion ?? 0;
      const diff = await endpoints.modelDiff(missionId, from, entry.version);
      const labels = new Map<string, string>();
      const collect = (model: BusinessModel): void => {
        for (const element of Object.values(model.elements)) labels.set(element.id, element.label);
      };
      collect((await endpoints.modelAt(missionId, entry.version)).model);
      if (diff.removed.length > 0 && from > 0) {
        collect((await endpoints.modelAt(missionId, from)).model);
      }
      setChanges({ status: 'ready', changes: { diff, labels } });
    } catch (e) {
      setOpen(null);
      showToast({ tone: 'error', title: errorMessage(e) });
    }
  }

  async function rollback(version: number): Promise<void> {
    setBusy(true);
    try {
      const result = await endpoints.rollback(missionId, version);
      showToast({
        tone: 'success',
        title: t('analysis.history.rolledBack'),
        description: t('analysis.history.rolledBackDetail', {
          version: result.version,
          from: version,
        }),
      });
      setConfirm(null);
      setOpen(null);
      await load();
    } catch (e) {
      showToast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  const ordered = versions === null ? null : [...versions].sort((a, b) => b.version - a.version);
  const head = ordered?.[0]?.version ?? null;

  return (
    <section aria-labelledby="analysis-history" className="card stack">
      <div className="stack-sm">
        <h2 id="analysis-history" className="h3">
          {t('analysis.history.heading')}
        </h2>
        <p className="muted small">{t('analysis.history.hint')}</p>
      </div>
      {error !== null ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {ordered === null && error === null ? <p role="status">{t('ui.loading')}</p> : null}
      {ordered !== null && ordered.length === 0 ? (
        <p className="muted">{t('analysis.history.empty')}</p>
      ) : null}
      {ordered !== null && ordered.length > 0 ? (
        <ol className="plain stack" aria-label={t('analysis.history.list')}>
          {ordered.map((entry) => (
            <li key={entry.version} className="version-item" data-testid="version-item">
              <div className="row version-head">
                <span className="strong">
                  {t('analysis.history.version', { version: entry.version })}
                </span>
                {entry.version === head ? (
                  <span className="muted small">({t('analysis.history.current')})</span>
                ) : null}
                <span>{causeLabel(entry.cause)}</span>
                <span className="muted small">{formatDateTime(entry.createdAt)}</span>
                {entry.authorId === selfId ? (
                  <span className="muted small">{t('analysis.history.byYou')}</span>
                ) : null}
              </div>
              {entry.summary !== null ? <p className="small">{entry.summary}</p> : null}
              <div className="row">
                <Button
                  variant="quiet"
                  aria-expanded={open === entry.version}
                  onPress={() => void toggle(entry)}
                >
                  {open === entry.version
                    ? t('analysis.history.hideChanges')
                    : t('analysis.history.showChanges')}
                </Button>
                {canRollback && entry.version !== head ? (
                  <Button
                    variant="secondary"
                    aria-label={t('analysis.history.rollbackLabel', { version: entry.version })}
                    onPress={() => setConfirm(entry.version)}
                  >
                    {t('analysis.history.rollback')}
                  </Button>
                ) : null}
              </div>
              {open === entry.version ? (
                changes.status === 'loading' ? (
                  <p role="status">{t('analysis.history.loadingChanges')}</p>
                ) : (
                  <ChangesView version={entry.version} changes={changes.changes} />
                )
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      <Dialog
        title={confirm === null ? '' : t('analysis.history.rollbackTitle', { version: confirm })}
        isOpen={confirm !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirm(null);
        }}
      >
        <div className="stack">
          <p>{confirm === null ? '' : t('analysis.history.rollbackBody', { version: confirm })}</p>
          <div className="row end">
            <Button variant="secondary" onPress={() => setConfirm(null)}>
              {t('ui.cancel')}
            </Button>
            <Button
              isDisabled={busy}
              onPress={() => {
                if (confirm !== null) void rollback(confirm);
              }}
            >
              {t('analysis.history.rollbackConfirm')}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
