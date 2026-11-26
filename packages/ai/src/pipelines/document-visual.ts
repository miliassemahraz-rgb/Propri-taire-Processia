import { z } from 'zod';
import { loadPrompt } from '../prompts.js';
import type { PipelineDef } from '../runner.js';

export const documentVisualOutputSchema = z.object({
  pages: z
    .array(z.object({ page: z.number().int().min(1), text: z.string() }))
    .min(1)
    .max(500),
});
export type DocumentVisualOutput = z.infer<typeof documentVisualOutputSchema>;

export interface DocumentVisualInput {
  name: string;
  kind: 'pdf' | 'image';
  mediaType: string;
  data: Uint8Array;
}

/**
 * `extraction.document_visual` (spécification 4.4) : transcription par page d'un PDF scanné ou
 * d'une image, transmis en pièce jointe (capacité `documents`). La source textuelle dérivée est
 * ensuite découpée comme n'importe quel texte. Le scénario factice du pilote relève de WP-12.
 */
export const documentVisualPipeline: PipelineDef<DocumentVisualInput, DocumentVisualOutput> = {
  name: 'extraction.document_visual',
  version: '1',
  schemaName: 'DocumentVisualTranscription',
  outputSchema: documentVisualOutputSchema,
  buildRequest: (input) => ({
    system: loadPrompt('extraction.document_visual'),
    messages: [{ role: 'user', content: `Transcris le document joint « ${input.name} ».` }],
    attachments: [
      { kind: input.kind, mediaType: input.mediaType, data: input.data, name: input.name },
    ],
    maxOutputTokens: 16_000,
    effort: 'low',
  }),
  semanticCheck: (output) => {
    const seen = new Set<number>();
    const issues: { path: string; message: string }[] = [];
    output.pages.forEach((page, index) => {
      if (seen.has(page.page)) {
        issues.push({ path: `pages.${index}.page`, message: `Page ${page.page} en double.` });
      }
      seen.add(page.page);
    });
    return issues;
  },
};
