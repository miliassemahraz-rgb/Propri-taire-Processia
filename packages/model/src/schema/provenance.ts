import { z } from 'zod';
import { ISODateTimeSchema, SourceIdSchema, UserIdSchema } from './ids.js';

export const ORIGIN_KINDS = [
  'free_text',
  'answer',
  'document',
  'interview',
  'system_log',
  'ai_knowledge',
  'past_mission',
  'consultant',
  'deterministic_rule',
] as const;
export const OriginKindSchema = z.enum(ORIGIN_KINDS);
export type OriginKind = z.infer<typeof OriginKindSchema>;

export const ELEMENT_STATUSES = ['extracted', 'hypothesis', 'confirmed', 'validated'] as const;
export const ElementStatusSchema = z.enum(ELEMENT_STATUSES);
export type ElementStatus = z.infer<typeof ElementStatusSchema>;

const nonNegInt = z.number().int().nonnegative();

export const SourceRefSchema = z
  .strictObject({
    sourceId: SourceIdSchema,
    sourceRevision: nonNegInt,
    chunkId: z.string().min(1).optional(),
    locator: z.strictObject({
      page: nonNegInt.optional(),
      sheet: z.string().optional(),
      cell: z.string().optional(),
      paragraph: nonNegInt.optional(),
      charStart: nonNegInt,
      charEnd: nonNegInt,
    }),
    quote: z.string().min(1),
  })
  .meta({ id: 'SourceRef' });
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const ProvenanceSchema = z
  .strictObject({
    origin: OriginKindSchema,
    refs: z.array(SourceRefSchema),
    rationale: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    aiCallId: z.string().min(1).optional(),
    author: z.strictObject({
      type: z.enum(['ai', 'user', 'system']),
      userId: UserIdSchema.optional(),
    }),
    at: ISODateTimeSchema,
  })
  // CDC 6.4 : « connaissance générale de l'IA » exige une justification.
  .refine((p) => p.origin !== 'ai_knowledge' || p.rationale !== undefined, {
    path: ['rationale'],
    message: "La justification (rationale) est obligatoire pour l'origine ai_knowledge",
  })
  .meta({ id: 'Provenance' });
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const StatusInfoSchema = z
  .strictObject({
    value: ElementStatusSchema,
    decidedBy: UserIdSchema.optional(),
    decidedAt: ISODateTimeSchema.optional(),
    correction: z.strictObject({ previous: z.unknown(), note: z.string().optional() }).optional(),
    validatedInSubmission: z.string().min(1).optional(),
    changedAfterValidation: z
      .strictObject({ version: z.number().int().positive(), at: ISODateTimeSchema })
      .nullable()
      .optional(),
  })
  .meta({ id: 'StatusInfo' });
export type StatusInfo = z.infer<typeof StatusInfoSchema>;
