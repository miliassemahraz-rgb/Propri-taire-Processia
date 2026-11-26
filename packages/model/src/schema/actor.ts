import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';

export const ActorSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('actor'),
    category: z.enum(['internal', 'external', 'third_party_system']),
    responsibilities: z.array(z.string()),
    stakeholder: z.boolean().optional(),
    parentId: ElementIdSchema.optional(),
    appRole: z.boolean().optional(),
  }),
).meta({ id: 'Actor' });
export type Actor = z.infer<typeof ActorSchema>;
