'use client';

import { useState } from 'react';
import type { CommentDto, CommentTargetKind, SubmissionDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import { Button, StatusBadge, TextField, showToast } from '@processia/ui';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { threadsFor } from '../../lib/validation';

interface Props {
  missionId: string;
  submission: SubmissionDto;
  targetKind: CommentTargetKind;
  targetId: string;
  /** Titre du fil (niveau 3). */
  title: string;
  comments: CommentDto[];
  /** Le compte peut écrire (soumission en cours ou validée, droit `comment.create`). */
  canComment: boolean;
  onChanged: () => void;
}

function Entry({ comment }: { comment: CommentDto }) {
  const role =
    comment.author.role === 'validator'
      ? t('validation.comments.byValidator')
      : t('validation.comments.byTeam');
  return (
    <div className="stack-sm">
      <p className="small muted">
        {t('validation.comments.authorLine', {
          name: comment.author.name,
          role,
          date: formatDateTime(comment.createdAt),
        })}
      </p>
      <p className="comment-body">{comment.body}</p>
    </div>
  );
}

/**
 * Fil de discussion d'une cible (élément, livrable ou soumission) sur la version figée : les
 * commentaires, leurs réponses, la résolution du fil et la saisie d'un nouveau commentaire.
 */
export function CommentThread({
  missionId,
  submission,
  targetKind,
  targetId,
  title,
  comments,
  canComment,
  onChanged,
}: Props) {
  const threads = threadsFor(comments, submission.id, targetKind, targetId);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  async function post(body: string, parentId?: string): Promise<boolean> {
    if (body.trim() === '') return false;
    setBusy(true);
    try {
      await endpoints.createComment(missionId, {
        targetKind,
        targetId,
        submissionId: submission.id,
        body,
        ...(parentId === undefined ? {} : { parentId }),
      });
      showToast({ tone: 'success', title: t('validation.comments.sent') });
      onChanged();
      return true;
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function resolve(comment: CommentDto, resolved: boolean): Promise<void> {
    try {
      await endpoints.resolveComment(missionId, comment.id, resolved);
      onChanged();
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    }
  }

  return (
    <section className="stack-sm comment-thread" aria-label={title} data-testid="comment-thread">
      <h4 className="h5">{title}</h4>
      {threads.length === 0 ? (
        <p className="muted small">{t('validation.comments.empty')}</p>
      ) : null}
      {threads.length > 0 ? (
        <ul className="stack plain" aria-label={t('validation.comments.thread')}>
          {threads.map(({ root, replies }) => (
            <li key={root.id} className="card-soft stack-sm" data-testid="comment">
              <Entry comment={root} />
              {replies.length > 0 ? (
                <ul className="stack-sm plain comment-replies">
                  {replies.map((entry) => (
                    <li key={entry.id} data-testid="comment-reply">
                      <Entry comment={entry} />
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="row">
                {root.resolvedAt !== null ? (
                  <StatusBadge tone="success">{t('validation.comments.resolved')}</StatusBadge>
                ) : null}
                {canComment ? (
                  <>
                    <Button
                      variant="secondary"
                      onPress={() => {
                        setReplyTo(replyTo === root.id ? null : root.id);
                        setReply('');
                      }}
                    >
                      {t('validation.comments.reply')}
                    </Button>
                    <Button
                      variant="quiet"
                      onPress={() => void resolve(root, root.resolvedAt === null)}
                    >
                      {root.resolvedAt === null
                        ? t('validation.comments.resolve')
                        : t('validation.comments.reopen')}
                    </Button>
                  </>
                ) : null}
              </div>
              {replyTo === root.id ? (
                <div className="stack-sm">
                  <TextField
                    label={t('validation.comments.replyLabel')}
                    multiline
                    value={reply}
                    onChange={setReply}
                  />
                  <div className="row">
                    <Button
                      isDisabled={busy || reply.trim() === ''}
                      onPress={() => {
                        void post(reply, root.id).then((ok) => {
                          if (ok) {
                            setReply('');
                            setReplyTo(null);
                          }
                        });
                      }}
                    >
                      {t('validation.comments.send')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canComment ? (
        <div className="stack-sm">
          <TextField
            label={t('validation.comments.label')}
            multiline
            value={draft}
            onChange={setDraft}
          />
          <div className="row">
            <Button
              isDisabled={busy || draft.trim() === ''}
              onPress={() => {
                void post(draft).then((ok) => {
                  if (ok) setDraft('');
                });
              }}
            >
              {t('validation.comments.send')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="muted small">{t('validation.comments.closed')}</p>
      )}
    </section>
  );
}
