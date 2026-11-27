import { existsSync } from 'node:fs';
import { messages } from '@processia/i18n';
import { buildCompleteModel } from '@processia/model';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { buildDossier, renderPdf } from './index.js';

// Rendu PDF par Chromium (Playwright) : exige un Chromium, indiqué par
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ou installé par `playwright install` (voir le RUNBOOK).

const executablePath =
  process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

interface OutlineItem {
  title: string;
  items: OutlineItem[];
}

function titles(items: OutlineItem[]): string[] {
  return items.flatMap((item) => [item.title, ...titles(item.items)]);
}

describe('PDF du dossier d’analyse (Chromium)', () => {
  it('a des signets et du texte extractible', { timeout: 60_000 }, async () => {
    const doc = buildDossier({
      model: buildCompleteModel(),
      sources: [],
      mission: { name: 'Mission pilote', clientName: 'Cabinet Exemple' },
      producedAt: '2026-11-27T10:00:00.000Z',
    });
    const bytes = await renderPdf(doc, { executablePath });
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');

    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const outline = (await pdf.getOutline()) as OutlineItem[] | null;
    expect(outline, 'le PDF doit avoir des signets').not.toBeNull();
    const all = titles(outline ?? []);
    for (const section of doc.deliverables) expect(all).toContain(section.title);
    expect(all).toContain(doc.annex.title);
    expect(all).toContain(messages.exports.caption.raci);

    const extracted = await extractText(pdf, { mergePages: true });
    const { totalPages } = extracted;
    const text = extracted.text.replace(/\s+/g, ' ');
    expect(totalPages).toBeGreaterThan(3);
    expect(text).toContain(doc.title);
    expect(text).toContain(messages.exports.deliverable.rules_register);
    expect(text).toContain('Relance des pièces manquantes');
    expect(text).toContain('Client injoignable');

    // PDF balisé : structure logique présente.
    expect(Buffer.from(bytes).includes('/StructTreeRoot')).toBe(true);
  });
});
