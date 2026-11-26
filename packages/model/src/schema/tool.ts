import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';

export const ToolSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('tool'),
    nature: z.enum(['software', 'spreadsheet', 'email', 'paper', 'phone', 'other']),
    systemActorId: ElementIdSchema.optional(),
  }),
).meta({ id: 'Tool' });
export type Tool = z.infer<typeof ToolSchema>;
