import { z } from 'zod';
import { baseShape, withBaseRules } from './base.js';
import { ElementIdSchema } from './ids.js';
import { ProvenanceSchema, StatusInfoSchema } from './provenance.js';

export const FIELD_TYPES = [
  'text',
  'number',
  'amount',
  'date',
  'boolean',
  'enum',
  'file',
  'reference',
] as const;
export const FieldTypeSchema = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const DataFieldSchema = withBaseRules(
  z.strictObject({
    id: ElementIdSchema,
    name: z.string().min(1),
    type: FieldTypeSchema,
    required: z.boolean().optional(),
    enumValues: z.array(z.string()).optional(),
    referenceObjectId: ElementIdSchema.optional(),
    description: z.string().optional(),
    personalData: z.boolean().optional(),
    provenance: ProvenanceSchema,
    status: StatusInfoSchema,
  }),
).meta({ id: 'DataField' });
export type DataField = z.infer<typeof DataFieldSchema>;

export const DataObjectSchema = withBaseRules(
  z.strictObject({
    ...baseShape,
    kind: z.literal('data_object'),
    nature: z.enum(['business_object', 'document', 'form']),
    fields: z.array(DataFieldSchema),
    toolIds: z.array(ElementIdSchema),
    lifecycleStates: z.array(z.string()).optional(),
    personalData: z.boolean().optional(),
  }),
).meta({ id: 'DataObject' });
export type DataObject = z.infer<typeof DataObjectSchema>;
