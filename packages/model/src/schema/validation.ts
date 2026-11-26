import { z } from 'zod';
import { ElementIdSchema, ISODateTimeSchema, UserIdSchema } from './ids.js';

export const SUBMISSION_KINDS = ['analysis_dossier', 'as_is', 'to_be'] as const;
export const SubmissionKindSchema = z.enum(SUBMISSION_KINDS);
export type SubmissionKind = z.infer<typeof SubmissionKindSchema>;

export const ValidationSubmissionSchema = z
  .strictObject({
    id: z.string().min(1),
    missionId: z.string().min(1),
    kind: SubmissionKindSchema,
    round: z.number().int().positive(),
    modelVersion: z.number().int().positive(),
    artifactIds: z.array(z.string()),
    excludedHypothesisIds: z.array(ElementIdSchema),
    status: z.enum(['submitted', 'validated', 'superseded', 'withdrawn', 'closed']),
    submittedBy: UserIdSchema,
    submittedAt: ISODateTimeSchema,
    decidedBy: UserIdSchema.optional(),
    decidedAt: ISODateTimeSchema.optional(),
    comment: z.string().optional(),
  })
  .meta({ id: 'ValidationSubmission' });
export type ValidationSubmission = z.infer<typeof ValidationSubmissionSchema>;

export const OptimisationDecisionSchema = z
  .strictObject({
    id: z.string().min(1),
    submissionId: z.string().min(1),
    optimisationId: ElementIdSchema,
    value: z.enum(['accepted', 'rejected']),
    cause: z.enum(['direct', 'cascade']),
    cascadeFrom: ElementIdSchema.optional(),
    comment: z.string().optional(),
    by: UserIdSchema,
    at: ISODateTimeSchema,
    supersededAt: ISODateTimeSchema.optional(),
  })
  .meta({ id: 'OptimisationDecision' });
export type OptimisationDecision = z.infer<typeof OptimisationDecisionSchema>;

export const PostValidationNoticeSchema = z
  .strictObject({
    id: z.string().min(1),
    missionId: z.string().min(1),
    submissionId: z.string().min(1),
    elementId: ElementIdSchema,
    version: z.number().int().positive(),
    summary: z.string().min(1),
    createdAt: ISODateTimeSchema,
    seenAt: ISODateTimeSchema.optional(),
  })
  .meta({ id: 'PostValidationNotice' });
export type PostValidationNotice = z.infer<typeof PostValidationNoticeSchema>;
