import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';

export const GlossaryTermSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('glossary_term'),
    term: z.string().min(1),
    definition: z.string().min(1),
    synonyms: z.array(z.string()),
  }),
).meta({ id: 'GlossaryTerm' });
export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>;
