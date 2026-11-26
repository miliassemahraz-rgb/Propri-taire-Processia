import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';

export const ProcessEventSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('event'),
    containerId: ElementIdSchema,
    position: z.enum(['start', 'end', 'intermediate', 'boundary']),
    trigger: z.enum(['none', 'message', 'timer', 'error', 'signal', 'conditional']),
    attachedToId: ElementIdSchema.optional(),
    actorId: ElementIdSchema.optional(),
    timer: z.string().optional(),
  }),
)
  .refine((e) => e.position !== 'boundary' || e.attachedToId !== undefined, {
    path: ['attachedToId'],
    message: 'Un événement de bordure exige attachedToId',
  })
  .meta({ id: 'ProcessEvent' });
export type ProcessEvent = z.infer<typeof ProcessEventSchema>;
