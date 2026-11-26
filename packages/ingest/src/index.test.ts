import {
  buildDocx,
  buildPdf,
  buildPng,
  buildScannedPdf,
  buildXlsx,
} from '@processia/test-fixtures';
import { describe, expect, it } from 'vitest';
import {
  chunkBlocks,
  detectFile,
  extractDocumentText,
  IngestError,
  MAX_FILE_BYTES,
  PACKAGE_NAME,
  type ExtractionResult,
  type TextBlock,
} from './index.js';

function okBlocks(result: ExtractionResult): TextBlock[] {
  if (result.status !== 'ok') throw new Error('extraction attendue');
  return result.blocks;
}

describe('@processia/ingest', () => {
  it('expose le paquet', () => {
    expect(PACKAGE_NAME).toBe('@processia/ingest');
  });

  describe('détection par signature', () => {
    it('reconnaît PDF, DOCX, XLSX, PNG et texte', async () => {
      expect((await detectFile(buildPdf([['Bonjour']]), 'a.pdf')).kind).toBe('pdf');
      expect((await detectFile(await buildDocx([{ text: 'x' }]), 'a.docx')).kind).toBe('docx');
      expect(
        (await detectFile(await buildXlsx([{ name: 'F', rows: [['a']] }]), 'a.xlsx')).kind,
      ).toBe('xlsx');
      expect((await detectFile(buildPng(), 'a.png')).kind).toBe('image');
      expect((await detectFile(Buffer.from('# Titre\ntexte', 'utf8'), 'a.md')).kind).toBe('text');
    });

    it('refuse un type falsifié (extension qui ne correspond pas à la signature)', async () => {
      await expect(detectFile(buildPng(), 'facture.pdf')).rejects.toMatchObject({
        code: 'UNSUPPORTED_FILE_TYPE',
      });
      await expect(detectFile(buildPdf([['x']]), 'notes.txt')).rejects.toMatchObject({
        code: 'UNSUPPORTED_FILE_TYPE',
      });
      // Un exécutable renommé en PDF, un texte déguisé en PDF, un classeur déguisé en DOCX.
      await expect(
        detectFile(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]), 'a.pdf'),
      ).rejects.toBeInstanceOf(IngestError);
      await expect(detectFile(Buffer.from('juste du texte'), 'a.pdf')).rejects.toBeInstanceOf(
        IngestError,
      );
      await expect(
        detectFile(await buildXlsx([{ name: 'F', rows: [['a']] }]), 'a.docx'),
      ).rejects.toBeInstanceOf(IngestError);
    });

    it('refuse une extension inconnue, un fichier vide et un texte binaire', async () => {
      await expect(detectFile(Buffer.from('x'), 'a.exe')).rejects.toBeInstanceOf(IngestError);
      await expect(detectFile(Buffer.alloc(0), 'a.txt')).rejects.toBeInstanceOf(IngestError);
      await expect(detectFile(Buffer.from([0, 1, 2, 3]), 'a.txt')).rejects.toBeInstanceOf(
        IngestError,
      );
    });

    it('refuse plus de 50 Mo', async () => {
      const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x20);
      await expect(detectFile(big, 'a.txt')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    });
  });

  describe('extraction et localisateurs', () => {
    it('PDF : une page par bloc, localisée par numéro de page', async () => {
      const pdf = buildPdf([
        ['Page un : le cabinet reçoit les dossiers.'],
        ['Page deux : la comptable saisit les écritures.'],
      ]);
      const result = await extractDocumentText('pdf', pdf);
      const blocks = okBlocks(result);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.locator).toEqual({ kind: 'page', pageStart: 1, pageEnd: 1 });
      expect(blocks[1]?.locator).toEqual({ kind: 'page', pageStart: 2, pageEnd: 2 });
      expect(blocks[1]?.text).toContain('écritures');
      const chunks = chunkBlocks(blocks);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.locator).toEqual({ kind: 'page', pageStart: 1, pageEnd: 2 });
    });

    it('PDF scanné ou image : demande un fournisseur doté de « documents »', async () => {
      expect(await extractDocumentText('pdf', buildScannedPdf(2))).toMatchObject({
        status: 'needs_vision',
        reason: 'scanned_pdf',
        pageCount: 2,
      });
      expect(await extractDocumentText('image', buildPng())).toMatchObject({
        status: 'needs_vision',
        reason: 'image',
      });
    });

    it('DOCX : paragraphes numérotés et dernier titre rencontré', async () => {
      const docx = await buildDocx([
        { text: 'Présentation', heading: 1 },
        { text: 'Le cabinet compte douze salariés.' },
        { text: 'Facturation', heading: 2 },
        { text: 'La facturation est mensuelle & automatisée.' },
      ]);
      const blocks = okBlocks(await extractDocumentText('docx', docx));
      expect(blocks.map((b) => b.locator)).toEqual([
        { kind: 'paragraph', paragraphStart: 1, paragraphEnd: 1, heading: 'Présentation' },
        { kind: 'paragraph', paragraphStart: 2, paragraphEnd: 2, heading: 'Présentation' },
        { kind: 'paragraph', paragraphStart: 3, paragraphEnd: 3, heading: 'Facturation' },
        { kind: 'paragraph', paragraphStart: 4, paragraphEnd: 4, heading: 'Facturation' },
      ]);
      expect(blocks[3]?.text).toBe('La facturation est mensuelle & automatisée.');
    });

    it('XLSX : une ligne par bloc, feuille et plage de cellules, jamais de morceau à cheval', async () => {
      const xlsx = await buildXlsx([
        {
          name: 'Acteurs',
          rows: [
            ['Acteur', 'Rôle'],
            ['Comptable', 'Saisie'],
            ['Associé', 'Validation'],
          ],
        },
        {
          name: 'Outils',
          rows: [
            ['Outil', 'Usage', 'Coût'],
            ['Excel', null, 10],
          ],
        },
      ]);
      const blocks = okBlocks(await extractDocumentText('xlsx', xlsx));
      expect(blocks).toHaveLength(5);
      expect(blocks[1]).toMatchObject({
        text: 'Acteur : Comptable | Rôle : Saisie',
        locator: { kind: 'cell', sheet: 'Acteurs', range: 'A2:B2', rowStart: 2, rowEnd: 2 },
      });
      expect(blocks[4]?.locator).toEqual({
        kind: 'cell',
        sheet: 'Outils',
        range: 'A2:C2',
        rowStart: 2,
        rowEnd: 2,
      });
      const chunks = chunkBlocks(blocks);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]?.locator).toEqual({
        kind: 'cell',
        sheet: 'Acteurs',
        range: 'A1:B3',
        rowStart: 1,
        rowEnd: 3,
      });
      expect(chunks[1]?.locator).toMatchObject({ kind: 'cell', sheet: 'Outils' });
    });

    it('TXT : paragraphes localisés par lignes', async () => {
      const text = 'Premier paragraphe\nsur deux lignes.\n\nSecond paragraphe.\n';
      const blocks = okBlocks(await extractDocumentText('text', Buffer.from(text)));
      expect(blocks.map((b) => b.locator)).toEqual([
        { kind: 'line', lineStart: 1, lineEnd: 2 },
        { kind: 'line', lineStart: 4, lineEnd: 4 },
      ]);
    });
  });

  describe('découpage', () => {
    it('coupe un long bloc en morceaux bornés qui gardent le localisateur', () => {
      const sentence = 'La relance des pièces manquantes est faite par mail. ';
      const block: TextBlock = {
        text: sentence.repeat(200),
        section: 's',
        locator: { kind: 'page', pageStart: 3, pageEnd: 3 },
      };
      const chunks = chunkBlocks([block], 1000);
      expect(chunks.length).toBeGreaterThan(5);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(1000);
        expect(chunk.locator).toEqual({ kind: 'page', pageStart: 3, pageEnd: 3 });
      }
      expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_c, i) => i));
    });
  });
});
