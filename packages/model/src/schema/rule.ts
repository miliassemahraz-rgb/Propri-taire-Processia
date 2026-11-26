import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';

export const RULE_TYPES = [
  'business',
  'constraint',
  'decision',
  'exception',
  'dependency',
] as const;

export const RuleSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('rule'),
    type: z.enum(RULE_TYPES),
    statement: z.strictObject({
      text: z.string().min(1),
      when: z.string().optional(),
      then: z.string().optional(),
      otherwise: z.string().optional(),
    }),
    appliesTo: z.array(ElementIdSchema),
    dependsOn: z.array(ElementIdSchema).optional(),
    exceptionHandling: z
      .strictObject({
        circuit: z.enum(['reminder', 'escalation', 'deadline', 'alert', 'other']),
        description: z.string().min(1),
        activityIds: z.array(ElementIdSchema).optional(),
      })
      .optional(),
    legalReference: z.string().optional(),
    // RÉSERVÉ : incrément 2 (table de décision). Toute valeur est refusée.
    decisionTable: z.never().optional(),
  }),
).meta({ id: 'Rule' });
export type Rule = z.infer<typeof RuleSchema>;
