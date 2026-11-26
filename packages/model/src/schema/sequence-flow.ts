import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';

export const SequenceFlowSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('sequence_flow'),
    containerId: ElementIdSchema,
    fromId: ElementIdSchema,
    toId: ElementIdSchema,
    condition: z.string().optional(),
    ruleId: ElementIdSchema.optional(),
    isDefault: z.boolean().optional(),
  }),
).meta({ id: 'SequenceFlow' });
export type SequenceFlow = z.infer<typeof SequenceFlowSchema>;
