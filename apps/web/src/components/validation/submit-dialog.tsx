'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SubmissionPreviewDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import type { ElementKind } from '@processia/model';
import { Button, Dialog, Notice, TextField, showToast } from '@processia/ui';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preview: SubmissionPreviewDto };

/**
 * « Soumettre au validateur » (en-tête de l'espace Analyse, maquette `Analyse.dc.html`) :
 * l'aperçu fige la version de tête et liste les hypothèses exclues avant l'envoi (CDC 3.4).
 */
export function SubmitToValidator({ missionId }: { missionId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function show(): Promise<void> {
    setOpen(true);
    setNote('');
    setLoaded({ status: 'loading' });
    try {
      setLoaded({
        status: 'ready',
        preview: await endpoints.submissionPreview(missionId, 'analysis_dossier'),
      });
    } catch (error) {
      setLoaded({ status: 'error', message: errorMessage(error) });
    }
  }

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      const created = await endpoints.submit(missionId, {
        kind: 'analysis_dossier',
        ...(note.trim() === '' ? {} : { comment: note.trim() }),
      });
      showToast({ tone: 'success', title: t('validation.submit.done', { round: created.round }) });
      setOpen(false);
      router.push(`/missions/${missionId}/validation`);
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const preview = loaded.status === 'ready' ? loaded.preview : null;
  return (
    <>
      <Button onPress={() => void show()}>{t('validation.submit.button')}</Button>
      <Dialog title={t('validation.submit.title')} isOpen={open} onOpenChange={setOpen}>
        <div className="stack" data-testid="submit-dialog">
          {loaded.status === 'loading' ? (
            <p role="status">{t('validation.submit.loading')}</p>
          ) : null}
          {loaded.status === 'error' ? (
            <Notice tone="danger" role="alert">
              {loaded.message}
            </Notice>
          ) : null}
          {preview !== null ? (
            <>
              <p>{t('validation.submit.intro', { version: preview.modelVersion })}</p>
              <p data-testid="submit-included">
                {t('validation.submit.included', { count: preview.includedCount })}
              </p>
              {preview.blocker !== null ? (
                <Notice tone="warning" role="alert">
                  {t(`validation.submit.blocker.${preview.blocker}`)}
                </Notice>
              ) : null}
              <section className="stack-sm" aria-labelledby="submit-excluded">
                <h3 id="submit-excluded" className="h5" data-testid="submit-excluded-title">
                  {t('validation.submit.excludedHeading', {
                    count: preview.excludedHypotheses.length,
                  })}
                </h3>
                {preview.excludedHypotheses.length === 0 ? (
                  <p className="muted small">{t('validation.submit.excludedNone')}</p>
                ) : (
                  <>
                    <p className="muted small">{t('validation.submit.excludedHelp')}</p>
                    <ul className="stack-sm" aria-label={t('validation.submit.excludedList')}>
                      {preview.excludedHypotheses.map((hypothesis) => (
                        <li key={hypothesis.id}>
                          <span className="strong">{hypothesis.code}</span> {hypothesis.label}{' '}
                          <span className="muted small">
                            ({t(`analysis.kind.${hypothesis.kind as ElementKind}`)})
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
              {preview.replaces !== null ? (
                <Notice tone="info">
                  {t('validation.submit.replaces', { round: preview.replaces.round })}
                </Notice>
              ) : null}
              <TextField
                label={t('validation.submit.note')}
                multiline
                value={note}
                onChange={setNote}
              />
              <div className="row end">
                <Button variant="secondary" onPress={() => setOpen(false)}>
                  {t('ui.cancel')}
                </Button>
                <Button
                  isDisabled={busy || preview.blocker !== null}
                  onPress={() => void confirm()}
                >
                  {t('validation.submit.confirm', { version: preview.modelVersion })}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
