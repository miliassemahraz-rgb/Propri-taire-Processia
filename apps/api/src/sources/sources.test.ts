import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { safeFilename, sourceKey } from '../storage/storage.service.js';
import { descriptionTextFromState, workspaceDocName } from './yjs-text.js';

describe('texte de la description (Yjs)', () => {
  it('extrait un paragraphe par nœud de premier niveau', () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('description');
    const paragraph = (text: string): Y.XmlElement => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText(text)]);
      return p;
    };
    fragment.insert(0, [paragraph('Premier.'), paragraph('  '), paragraph('Second.')]);
    expect(descriptionTextFromState(Y.encodeStateAsUpdate(doc))).toBe('Premier.\n\nSecond.');
    expect(descriptionTextFromState(Y.encodeStateAsUpdate(new Y.Doc()))).toBe('');
    expect(workspaceDocName('m1')).toBe('mission:m1:workspace');
  });
});

describe('clés S3', () => {
  it('préfixe par la mission et neutralise le nom de fichier', () => {
    expect(sourceKey('m', 's', '../../etc/passwd')).toBe('missions/m/sources/s/passwd');
    expect(safeFilename('a"b<c>.pdf')).toBe('a_b_c_.pdf');
    expect(safeFilename('')).toBe('document');
    expect(safeFilename('C:\\dossier\\Contrat é.docx')).toBe('Contrat é.docx');
  });
});
