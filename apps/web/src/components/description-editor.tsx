'use client';

import Collaboration from '@tiptap/extension-collaboration';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';
import { WORKSPACE_DESCRIPTION_FRAGMENT } from '@processia/contracts';
import { t } from '@processia/i18n';
import { Notice } from '@processia/ui';
import { useCollab } from '../lib/collab';

/**
 * Description du métier : éditeur TipTap relié au `Y.XmlFragment` `description` du document
 * `workspace`. Lecture seule sans droit d'édition (non-membre, administrateur).
 */
export function DescriptionEditor() {
  const { workspace, canEdit, status } = useCollab();
  if (status === 'unavailable') {
    return <Notice tone="info">{t('collab.status.unavailable')}</Notice>;
  }
  if (workspace === null) return <p role="status">{t('ui.loading')}</p>;
  return <Editor key={workspace.configuration.name} editable={canEdit} />;
}

function Editor({ editable }: { editable: boolean }) {
  const { workspace } = useCollab();
  const document = workspace?.document;
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      extensions: [
        // L'historique local est remplacé par celui de Yjs.
        StarterKit.configure({ undoRedo: false }),
        ...(document === undefined
          ? []
          : [Collaboration.configure({ document, field: WORKSPACE_DESCRIPTION_FRAGMENT })]),
      ],
      editorProps: {
        attributes: {
          class: 'description-editor',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': t('collab.description.label'),
          ...(editable ? {} : { 'aria-readonly': 'true' }),
        },
      },
    },
    [document],
  );

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  return (
    <div className="stack">
      {editable ? null : <Notice tone="info">{t('collab.description.readOnly')}</Notice>}
      <EditorContent editor={editor} />
    </div>
  );
}
