'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { DialogueMessageDto, ProposalDto } from '@processia/contracts';
import { t } from '@processia/i18n';
import type { BusinessModel } from '@processia/model';
import { Button, Notice, StatusBadge, TextField, showToast } from '@processia/ui';
import { ApiRequestError } from '../../lib/api';
import { useMissionEvents } from '../../lib/collab';
import { buildPreview, type ChangeEntry, type DialoguePreview } from '../../lib/dialogue';
import { endpoints } from '../../lib/endpoints';
import { errorMessage } from '../../lib/errors';

const KNOWN_KINDS = [
  'activity',
  'event',
  'gateway',
  'sequence_flow',
  'rule',
  'indicator',
  'actor',
  'data_object',
  'information_flow',
] as const;
const KNOWN_FIELDS = [
  'label',
  'description',
  'responsibleActorId',
  'raci',
  'actorId',
  'toId',
  'fromId',
  'ruleIds',
  'appliesTo',
  'value',
  'unit',
  'status',
  'condition',
  'order',
] as const;
type KnownKind = (typeof KNOWN_KINDS)[number];
type KnownField = (typeof KNOWN_FIELDS)[number];

const kindLabel = (kind: string): string =>
  (KNOWN_KINDS as readonly string[]).includes(kind)
    ? t(`dialogue.kind.${kind as KnownKind}`)
    : t('dialogue.kind.other');
const fieldLabel = (field: string): string =>
  (KNOWN_FIELDS as readonly string[]).includes(field)
    ? t(`dialogue.field.${field as KnownField}`)
    : t('dialogue.field.other');

/** Une ligne du texte des différences (« Ajout : tâche P06.1.3 « … » »). */
export function entryText(entry: ChangeEntry): string {
  if (entry.kind === 'sequence_flow') {
    const route = entry.route ?? entry.label;
    return entry.change === 'added'
      ? t('dialogue.entry.flowAdded', { route })
      : entry.change === 'removed'
        ? t('dialogue.entry.flowRemoved', { route })
        : t('dialogue.entry.flowModified', { route });
  }
  const vars = { kind: kindLabel(entry.kind), code: entry.code, label: entry.label };
  return entry.change === 'added'
    ? t('dialogue.entry.added', vars)
    : entry.change === 'removed'
      ? t('dialogue.entry.removed', vars)
      : t('dialogue.entry.modified', {
          ...vars,
          fields: [...new Set(entry.fields.map(fieldLabel))].join(', '),
        });
}

interface CardProps {
  proposal: ProposalDto;
  model: BusinessModel;
  canEdit: boolean;
  previewed: boolean;
  busy: boolean;
  /** Dernière proposition appliquée, encore à la tête : retour arrière en un clic. */
  undoable: boolean;
  onPreview: (id: string | null) => void;
  onApply: (proposal: ProposalDto) => void;
  onDiscard: (proposal: ProposalDto) => void;
  onRegenerate: (proposal: ProposalDto) => void;
  onUndo: (proposal: ProposalDto) => void;
}

const STATUS_TONE = {
  pending: 'info',
  applied: 'success',
  discarded: 'neutral',
  stale: 'warning',
} as const;

function ProposalCard({
  proposal,
  model,
  canEdit,
  previewed,
  busy,
  undoable,
  onPreview,
  onApply,
  onDiscard,
  onRegenerate,
  onUndo,
}: CardProps) {
  const pending = proposal.status === 'pending';
  const preview = useMemo<DialoguePreview | null>(
    () => (pending ? buildPreview(proposal, model) : null),
    [pending, proposal, model],
  );
  const statusText =
    proposal.status === 'applied'
      ? t('dialogue.proposal.status.applied', { version: proposal.appliedVersion ?? 0 })
      : t(`dialogue.proposal.status.${proposal.status}`);
  const entries = preview?.entries ?? [];
  const headingId = `proposal-${proposal.id}`;
  return (
    <section
      className="dialogue-proposal stack-sm"
      aria-labelledby={headingId}
      data-testid="proposal"
      data-status={proposal.status}
      data-proposal-id={proposal.id}
    >
      <div className="row dialogue-proposal-head">
        <h4 id={headingId} className="strong">
          {t('dialogue.proposal.heading')}
        </h4>
        <StatusBadge tone={STATUS_TONE[proposal.status]}>{statusText}</StatusBadge>
      </div>
      {pending ? (
        <>
          {proposal.adaptedToVersion !== null ? (
            <p className="small muted" data-testid="proposal-adapted">
              {t('dialogue.proposal.adapted', { version: proposal.adaptedToVersion })}
            </p>
          ) : null}
          {preview === null ? (
            <p className="small muted" role="status">
              {t('dialogue.proposal.outdated')}
            </p>
          ) : (
            <div className="stack-sm">
              <p className="small strong">{t('dialogue.proposal.changes')}</p>
              {entries.length === 0 ? (
                <p className="small muted">{t('dialogue.proposal.noChange')}</p>
              ) : (
                <ul className="dialogue-changes small" data-testid="proposal-changes">
                  {entries.map((entry) => (
                    <li
                      key={`${entry.change}-${entry.id}`}
                      className={`dialogue-change dialogue-change--${entry.change}`}
                      data-change={entry.change}
                      data-kind={entry.kind}
                    >
                      {entryText(entry)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="small" data-testid="proposal-warnings">
            {proposal.warnings.length === 0 ? (
              <p className="dialogue-ok">{t('dialogue.proposal.noWarnings')}</p>
            ) : (
              <>
                <p className="strong">{t('dialogue.proposal.warningsHeading')}</p>
                <ul>
                  {proposal.warnings.map((w) => (
                    <li key={`${w.code}-${w.elementId}`} data-code={w.code} data-testid="warning">
                      {t('dialogue.proposal.warningItem', { code: w.code, message: w.message })}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <div className="row">
            <Button
              variant="secondary"
              aria-pressed={previewed}
              isDisabled={preview === null}
              onPress={() => onPreview(previewed ? null : proposal.id)}
              data-testid="proposal-preview"
            >
              {previewed ? t('dialogue.proposal.hidePreview') : t('dialogue.proposal.showPreview')}
            </Button>
          </div>
          {canEdit ? (
            <div className="row">
              <Button
                isDisabled={busy || preview === null}
                onPress={() => onApply(proposal)}
                data-testid="proposal-apply"
              >
                {busy ? t('dialogue.proposal.applying') : t('dialogue.proposal.apply')}
              </Button>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => onDiscard(proposal)}
                data-testid="proposal-discard"
              >
                {t('dialogue.proposal.discard')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {proposal.status === 'stale' ? (
        <>
          <Notice tone="warning" role="status">
            {t('dialogue.proposal.staleNotice')}
          </Notice>
          {canEdit ? (
            <div className="row">
              <Button
                isDisabled={busy}
                onPress={() => onRegenerate(proposal)}
                data-testid="proposal-regenerate"
              >
                {t('dialogue.proposal.regenerate')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {proposal.status === 'applied' && undoable && proposal.appliedVersion !== null ? (
        <div className="stack-sm" data-testid="proposal-applied">
          <p className="small dialogue-ok" role="status">
            {t('dialogue.proposal.appliedNotice', { version: proposal.appliedVersion })}
          </p>
          {canEdit ? (
            <div className="row">
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => onUndo(proposal)}
                data-testid="proposal-undo"
              >
                {t('dialogue.proposal.undo', { version: proposal.appliedVersion - 1 })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

interface Props {
  missionId: string;
  model: BusinessModel;
  /** Diagramme affiché et élément sélectionné : ils réduisent le contexte envoyé à l'IA. */
  diagram: string;
  selectedId: string | null;
  canEdit: boolean;
  selfId: string;
  /** Aperçu avant/après de la proposition choisie (`null` : aucun). */
  onPreview: (preview: DialoguePreview | null) => void;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; messages: DialogueMessageDto[]; proposals: Map<string, ProposalDto> };

/**
 * Panneau « Modifier par dialogue » (WP-20, spécification 6.3 et CDC 4.2) : le consultant écrit
 * une consigne, l'assistant répond par une proposition en aperçu (différences en texte, avant et
 * après dans la visionneuse, incohérences créées) ou par une question de clarification. Rien
 * n'est enregistré avant « Appliquer ». Une proposition périmée se régénère sur la version actuelle.
 */
export function DialoguePanel({
  missionId,
  model,
  diagram,
  selectedId,
  canEdit,
  selfId,
  onPreview,
}: Props) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLOListElement | null>(null);

  const load = useCallback(async () => {
    try {
      const dto = await endpoints.dialogue(missionId);
      // Les propositions en attente sont relues une à une : l'API les rebase sur la tête ou les
      // déclare périmées (`stale`).
      const refreshed = await Promise.all(
        dto.proposals.map((p) =>
          p.status === 'pending' ? endpoints.proposal(missionId, p.id).catch(() => p) : p,
        ),
      );
      setLoaded({
        status: 'ready',
        messages: dto.messages,
        proposals: new Map(refreshed.map((p) => [p.id, p])),
      });
    } catch {
      setLoaded((previous) => (previous.status === 'ready' ? previous : { status: 'error' }));
    }
  }, [missionId]);

  useEffect(() => {
    void load();
  }, [load, model.version]);
  useMissionEvents((message) => {
    if (message.type === 'proposal.updated') void load();
  });

  const proposals = loaded.status === 'ready' ? loaded.proposals : null;
  const messages = loaded.status === 'ready' ? loaded.messages : null;

  // Aperçu transmis à la visionneuse : recalculé à chaque version du modèle.
  const previewed = previewId === null ? undefined : proposals?.get(previewId);
  const preview = useMemo(
    () =>
      previewed !== undefined && previewed.status === 'pending'
        ? buildPreview(previewed, model)
        : null,
    [previewed, model],
  );
  useEffect(() => {
    onPreview(preview);
  }, [preview, onPreview]);
  useEffect(() => () => onPreview(null), [onPreview]);
  useEffect(() => {
    if (previewId !== null && previewed !== undefined && previewed.status !== 'pending') {
      setPreviewId(null);
    }
  }, [previewId, previewed]);

  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [messages?.length]);

  async function send(): Promise<void> {
    const value = text.trim();
    if (value === '' || sending) return;
    setSending(true);
    setAnnouncement(t('dialogue.composer.sending'));
    try {
      const result = await endpoints.sendDialogue(missionId, {
        text: value,
        focus: { diagram, ...(selectedId === null ? {} : { selectedId }) },
      });
      setText('');
      setAnnouncement(result.messages[result.messages.length - 1]?.content ?? '');
      if (result.proposal !== null) setPreviewId(result.proposal.id);
      await load();
    } catch (error) {
      setAnnouncement('');
      showToast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setSending(false);
    }
  }

  async function apply(proposal: ProposalDto): Promise<void> {
    setBusyId(proposal.id);
    try {
      const done = await endpoints.applyProposal(missionId, proposal.id);
      showToast({
        tone: 'success',
        title: t('dialogue.proposal.appliedToast'),
        description: t('dialogue.proposal.appliedNotice', { version: done.result.version }),
      });
      setAnnouncement(t('dialogue.proposal.appliedNotice', { version: done.result.version }));
    } catch (error) {
      // 409 : la proposition est devenue périmée ; la carte le montre après relecture.
      if (!(error instanceof ApiRequestError && error.code === 'STALE')) {
        showToast({ tone: 'error', title: errorMessage(error) });
      }
    } finally {
      setBusyId(null);
      await load();
    }
  }

  async function discard(proposal: ProposalDto): Promise<void> {
    setBusyId(proposal.id);
    try {
      await endpoints.discardProposal(missionId, proposal.id);
      showToast({ tone: 'info', title: t('dialogue.proposal.discardedToast') });
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setBusyId(null);
      await load();
    }
  }

  async function regenerate(proposal: ProposalDto): Promise<void> {
    setBusyId(proposal.id);
    try {
      const result = await endpoints.regenerateProposal(missionId, proposal.id, {
        focus: { diagram, ...(selectedId === null ? {} : { selectedId }) },
      });
      if (result.proposal !== null) {
        setPreviewId(result.proposal.id);
        setAnnouncement(t('dialogue.proposal.regenerated', { version: model.version }));
      } else {
        setAnnouncement(result.messages[result.messages.length - 1]?.content ?? '');
      }
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setBusyId(null);
      await load();
    }
  }

  async function undo(proposal: ProposalDto): Promise<void> {
    if (proposal.appliedVersion === null) return;
    setBusyId(proposal.id);
    try {
      const result = await endpoints.rollback(missionId, proposal.appliedVersion - 1);
      const message = t('dialogue.proposal.undone', {
        version: proposal.appliedVersion - 1,
        created: result.version,
      });
      showToast({ tone: 'success', title: message });
      setAnnouncement(message);
    } catch (error) {
      showToast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setBusyId(null);
      await load();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void send();
    }
  }

  // Dernière proposition appliquée, tant que le modèle est resté à sa version.
  const lastApplied = proposals
    ? [...proposals.values()]
        .filter((p) => p.status === 'applied' && p.appliedVersion !== null)
        .sort((a, b) => (b.appliedVersion ?? 0) - (a.appliedVersion ?? 0))[0]
    : undefined;
  const undoableId = lastApplied?.appliedVersion === model.version ? lastApplied.id : null;

  return (
    <aside
      className="map-panel stack-sm"
      aria-labelledby="dialogue-title"
      data-testid="dialogue-panel"
    >
      <h3 id="dialogue-title" className="h3">
        {t('dialogue.heading')}
      </h3>
      <p className="muted small">{t('dialogue.intro')}</p>
      {loaded.status === 'loading' ? <p role="status">{t('dialogue.loading')}</p> : null}
      {loaded.status === 'error' ? (
        <Notice tone="danger" role="alert">
          {t('dialogue.loadError')}
        </Notice>
      ) : null}
      {messages !== null && messages.length === 0 ? (
        <p className="muted small" data-testid="dialogue-empty">
          {t('dialogue.empty')}
        </p>
      ) : null}
      {messages !== null && messages.length > 0 && proposals !== null ? (
        <ol
          ref={listRef}
          className="plain dialogue-thread"
          aria-label={t('dialogue.thread')}
          data-testid="dialogue-thread"
          // Zone défilante : atteignable au clavier.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
        >
          {messages.map((m) => {
            const proposal = m.proposalId === null ? undefined : proposals.get(m.proposalId);
            const who =
              m.role === 'user'
                ? m.authorId === selfId
                  ? t('dialogue.who.you')
                  : t('dialogue.who.colleague')
                : m.role === 'assistant'
                  ? t('dialogue.who.assistant')
                  : t('dialogue.who.system');
            return (
              <li
                key={m.id}
                className={`dialogue-message dialogue-message--${m.role}`}
                data-testid="dialogue-message"
                data-role={m.role}
              >
                <span className="dialogue-who small">{who}</span>
                <p className="dialogue-text">{m.content}</p>
                {proposal !== undefined ? (
                  <ProposalCard
                    proposal={proposal}
                    model={model}
                    canEdit={canEdit}
                    previewed={previewId === proposal.id}
                    busy={busyId === proposal.id}
                    undoable={undoableId === proposal.id}
                    onPreview={setPreviewId}
                    onApply={(p) => void apply(p)}
                    onDiscard={(p) => void discard(p)}
                    onRegenerate={(p) => void regenerate(p)}
                    onUndo={(p) => void undo(p)}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      <p role="status" className="small" data-testid="dialogue-announcement">
        {announcement}
      </p>
      {canEdit ? (
        // Raccourci Ctrl+Entrée sur le champ ; le bouton « Envoyer » reste la voie principale.
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div className="stack-sm" onKeyDown={onKeyDown}>
          <TextField
            label={t('dialogue.composer.label')}
            description={t('dialogue.composer.help')}
            placeholder={t('dialogue.composer.placeholder')}
            multiline
            value={text}
            onChange={setText}
            isDisabled={sending}
            data-testid="dialogue-input"
          />
          <div className="row">
            <Button
              isDisabled={sending || text.trim() === ''}
              onPress={() => void send()}
              data-testid="dialogue-send"
            >
              {sending ? t('dialogue.composer.sending') : t('dialogue.composer.send')}
            </Button>
          </div>
        </div>
      ) : (
        <Notice tone="info">{t('dialogue.composer.readOnly')}</Notice>
      )}
    </aside>
  );
}
