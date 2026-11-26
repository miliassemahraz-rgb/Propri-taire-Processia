import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import type { ChangeSet } from './change-set.js';
import { ChangeSetSchema } from './change-set.js';
import { ElementIdSchema, ISODateTimeSchema, UserIdSchema } from './ids.js';

export const RangeSchema = z.strictObject({
  low: z.number(),
  high: z.number(),
  unit: z.string().min(1),
});
export type Range = z.infer<typeof RangeSchema>;

export const CalcAssumptionSchema = z.strictObject({
  label: z.string().min(1),
  value: z.number(),
  unit: z.string(),
  origin: z.enum(['standard_ratio', 'model_indicator', 'ai', 'consultant']),
  ref: z.string().optional(),
});
export type CalcAssumption = z.infer<typeof CalcAssumptionSchema>;

const Score5Schema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const GainEstimateSchema = z.strictObject({
  timeHoursPerYear: RangeSchema.optional(),
  costEurPerYear: RangeSchema.optional(),
  errorsAvoidedPerYear: RangeSchema.optional(),
  assumptions: z.array(CalcAssumptionSchema),
  formula: z.string().min(1),
  score: Score5Schema,
});
export type GainEstimate = z.infer<typeof GainEstimateSchema>;

export const EFFORT_DRIVERS = [
  'engine_configuration',
  'new_extension',
  'integration',
  'organisational_change',
  'data_migration',
] as const;

export const EffortEstimateSchema = z.strictObject({
  score: Score5Schema,
  justification: z.string().min(1),
  drivers: z.array(z.enum(EFFORT_DRIVERS)),
});
export type EffortEstimate = z.infer<typeof EffortEstimateSchema>;

export const OptimisationDecisionSnapshotSchema = z.strictObject({
  value: z.enum(['accepted', 'rejected']),
  cause: z.enum(['direct', 'cascade']),
  cascadeFrom: ElementIdSchema.optional(),
  submissionId: z.string().min(1),
  comment: z.string().optional(),
  at: ISODateTimeSchema,
  by: UserIdSchema,
});
export type OptimisationDecisionSnapshot = z.infer<typeof OptimisationDecisionSnapshotSchema>;

export const OptimisationSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('optimisation'),
    findingIds: z.array(ElementIdSchema).min(1),
    alternativeOf: ElementIdSchema.optional(),
    automationType: z
      .enum(['rules_notifications', 'documents', 'integration', 'ai_agent', 'organisational'])
      .optional(),
    changeSet: z.lazy((): z.ZodType<ChangeSet> => ChangeSetSchema),
    touchedElementIds: z.array(ElementIdSchema),
    dependsOn: z.array(ElementIdSchema),
    gain: GainEstimateSchema,
    effort: EffortEstimateSchema,
    decision: OptimisationDecisionSnapshotSchema.optional(),
  }),
).meta({ id: 'Optimisation' });
export type Optimisation = z.infer<typeof OptimisationSchema>;
