import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema, ISODateTimeSchema, UserIdSchema } from './ids.js';
import { SourceRefSchema } from './provenance.js';

export const DiscrepancySchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('discrepancy'),
    elementIds: z.array(ElementIdSchema),
    sides: z
      .array(z.strictObject({ claim: z.string().min(1), refs: z.array(SourceRefSchema) }))
      .min(2),
    state: z.enum(['open', 'resolved']),
    resolution: z
      .strictObject({
        note: z.string().min(1),
        by: UserIdSchema,
        at: ISODateTimeSchema,
        keptSide: z.number().int().nonnegative().optional(),
      })
      .optional(),
  }),
)
  .refine((d) => d.state !== 'resolved' || d.resolution !== undefined, {
    path: ['resolution'],
    message: 'Un écart résolu exige une résolution',
  })
  .meta({ id: 'Discrepancy' });
export type Discrepancy = z.infer<typeof DiscrepancySchema>;
