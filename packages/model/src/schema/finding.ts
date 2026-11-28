import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';

export const FINDING_FAMILIES = [
  'waste',
  'flow_and_delay',
  'organisation',
  'risk_compliance',
] as const;
export const FindingFamilySchema = z.enum(FINDING_FAMILIES);
export type FindingFamily = z.infer<typeof FindingFamilySchema>;

export const FINDING_TYPES = [
  'rekeying',
  'repetitive_task',
  'duplicate',
  'redundant_control',
  'useless_validation_loop',
  'bottleneck',
  'waiting_time',
  'flow_break',
  'paper_or_email_transfer',
  'task_without_owner',
  'incompatible_roles',
  'single_person_dependency',
  'missing_control',
  'missing_traceability',
  'uncovered_obligation',
] as const;
export const FindingTypeSchema = z.enum(FINDING_TYPES);
export type FindingType = z.infer<typeof FindingTypeSchema>;

/** Famille de chaque type de constat (spécification 2.4) : le type détermine la famille. */
export const FINDING_FAMILY_OF: Record<FindingType, FindingFamily> = {
  rekeying: 'waste',
  repetitive_task: 'waste',
  duplicate: 'waste',
  redundant_control: 'waste',
  useless_validation_loop: 'waste',
  bottleneck: 'flow_and_delay',
  waiting_time: 'flow_and_delay',
  flow_break: 'flow_and_delay',
  paper_or_email_transfer: 'flow_and_delay',
  task_without_owner: 'organisation',
  incompatible_roles: 'organisation',
  single_person_dependency: 'organisation',
  missing_control: 'risk_compliance',
  missing_traceability: 'risk_compliance',
  uncovered_obligation: 'risk_compliance',
};

export const FindingSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('finding'),
    family: FindingFamilySchema,
    type: FindingTypeSchema,
    location: z.array(ElementIdSchema).min(1),
    severity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    detection: z.strictObject({
      by: z.enum(['rule', 'ai']),
      detectorId: z.string().min(1).optional(),
    }),
    evidence: z.string().optional(),
  }),
).meta({ id: 'Finding' });
export type Finding = z.infer<typeof FindingSchema>;
