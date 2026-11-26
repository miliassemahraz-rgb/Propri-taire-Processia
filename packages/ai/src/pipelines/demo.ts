import { z } from 'zod';
import { loadPrompt } from '../prompts.js';
import type { PipelineDef } from '../runner.js';

export const demoSummarySchema = z.object({
  summary: z.string().min(1),
  keywords: z.array(z.string()).max(10),
});
export type DemoSummary = z.infer<typeof demoSummarySchema>;

export interface DemoSummaryInput {
  text: string;
  maxKeywords?: number;
}

/** Pipeline de démonstration (acceptation WP-09) : résumé et mots-clés d'un texte. */
export const demoSummaryPipeline: PipelineDef<DemoSummaryInput, DemoSummary> = {
  name: 'demo.summary',
  version: '1',
  schemaName: 'DemoSummary',
  outputSchema: demoSummarySchema,
  buildRequest: (input) => ({
    system: loadPrompt('demo.summary', { maxKeywords: input.maxKeywords ?? 5 }),
    messages: [{ role: 'user', content: `<document>\n${input.text}\n</document>` }],
    maxOutputTokens: 2_000,
    effort: 'low',
  }),
};
