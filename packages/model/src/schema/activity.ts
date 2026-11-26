import { z } from 'zod';
import { AutomationTypeSchema, EngineCapabilityIdSchema } from '../catalog/index.js';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';

export const ACTIVITY_LEVELS = ['macro', 'process', 'task', 'step'] as const;
export const ActivityLevelSchema = z.enum(ACTIVITY_LEVELS);
export type ActivityLevel = z.infer<typeof ActivityLevelSchema>;

export const RaciEntrySchema = z.strictObject({
  actorId: ElementIdSchema,
  role: z.enum(['R', 'A', 'C', 'I']),
});
export type RaciEntry = z.infer<typeof RaciEntrySchema>;

export const ActivitySchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('activity'),
    level: ActivityLevelSchema,
    parentId: ElementIdSchema.optional(),
    order: z.number().int().nonnegative().optional(),
    macroCategory: z.enum(['steering', 'core', 'support']).optional(),
    scope: z.enum(['mapping_only', 'application']).optional(),
    responsibleActorId: ElementIdSchema.optional(),
    raci: z.array(RaciEntrySchema),
    inputs: z.array(ElementIdSchema),
    outputs: z.array(ElementIdSchema),
    toolIds: z.array(ElementIdSchema),
    ruleIds: z.array(ElementIdSchema),
    trigger: z.string().optional(),
    execution: z.enum(['manual', 'user', 'automatic', 'ai_agent']),
    automation: z
      .strictObject({ type: AutomationTypeSchema, capability: EngineCapabilityIdSchema })
      .optional(),
  }),
)
  .refine((a) => a.level === 'macro' || a.parentId !== undefined, {
    path: ['parentId'],
    message: 'Une activité qui n’est pas un macroprocessus exige un parentId',
  })
  .meta({ id: 'Activity' });
export type Activity = z.infer<typeof ActivitySchema>;
