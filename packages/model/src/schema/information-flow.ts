import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';

export const FLOW_CHANNELS = [
  'paper',
  'email',
  'phone',
  'software',
  'portal',
  'oral',
  'other',
  'unknown',
] as const;

export const InformationFlowSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('information_flow'),
    fromActorId: ElementIdSchema,
    toActorId: ElementIdSchema,
    dataObjectIds: z.array(ElementIdSchema),
    channel: z.enum(FLOW_CHANNELS),
    activityId: ElementIdSchema.optional(),
    frequency: z.string().optional(),
  }),
).meta({ id: 'InformationFlow' });
export type InformationFlow = z.infer<typeof InformationFlowSchema>;
