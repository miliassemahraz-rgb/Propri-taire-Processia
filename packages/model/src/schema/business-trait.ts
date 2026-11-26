import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';

export const BUSINESS_TRAIT_FACETS = [
  'sector',
  'environment',
  'specificity',
  'summary',
  'activity_statement',
] as const;

export const BusinessTraitSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('business_trait'),
    facet: z.enum(BUSINESS_TRAIT_FACETS),
    text: z.string().min(1),
  }),
).meta({ id: 'BusinessTrait' });
export type BusinessTrait = z.infer<typeof BusinessTraitSchema>;
