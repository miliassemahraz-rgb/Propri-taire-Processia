import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';

export const GatewaySchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('gateway'),
    containerId: ElementIdSchema,
    type: z.enum(['exclusive', 'parallel', 'inclusive']),
    ruleId: ElementIdSchema.optional(),
    actorId: ElementIdSchema.optional(),
  }),
).meta({ id: 'Gateway' });
export type Gateway = z.infer<typeof GatewaySchema>;
