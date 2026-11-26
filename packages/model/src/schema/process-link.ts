import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';

export const ProcessLinkSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('process_link'),
    fromId: ElementIdSchema,
    toId: ElementIdSchema,
    nature: z.enum(['sequence', 'feeds', 'steers', 'supports']),
    dataObjectIds: z.array(ElementIdSchema).optional(),
  }),
).meta({ id: 'ProcessLink' });
export type ProcessLink = z.infer<typeof ProcessLinkSchema>;
