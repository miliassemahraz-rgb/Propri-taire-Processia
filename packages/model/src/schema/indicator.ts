import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';

export const INDICATOR_MEASURES = [
  'volume',
  'lead_time',
  'duration',
  'frequency',
  'workload',
  'cost',
  'error_rate',
] as const;

export const IndicatorSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('indicator'),
    targetId: ElementIdSchema,
    measure: z.enum(INDICATOR_MEASURES),
    value: z.strictObject({
      exact: z.number().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
    }),
    unit: z.string().min(1),
    period: z.enum(['day', 'week', 'month', 'year', 'occurrence']).optional(),
    seasonality: z.string().optional(),
    nature: z.enum(['known', 'estimated']),
  }),
).meta({ id: 'Indicator' });
export type Indicator = z.infer<typeof IndicatorSchema>;
