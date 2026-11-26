import { z } from 'zod';
import { type Element, ElementSchema } from './element.js';
import { DiagramIdSchema, ElementIdSchema } from './ids.js';
import { type ElementStatus, ElementStatusSchema } from './provenance.js';

const BoxSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export const LayoutBoxSchema = BoxSchema.meta({ id: 'LayoutBox' });
export type LayoutBox = z.infer<typeof LayoutBoxSchema>;

/**
 * Les seules manières de changer un modèle (spécification 2.5). L'application est dans WP-03.
 * Le type est écrit à la main : `Element` contient `Optimisation`, qui contient un `ChangeSet`
 * (récursion que TypeScript ne sait pas inférer).
 */
export type ModelOp =
  | { op: 'add'; element: Element }
  | { op: 'update'; id: string; set: Record<string, unknown>; unset?: string[] | undefined }
  | { op: 'remove'; id: string; cascade?: string[] | undefined }
  | { op: 'set_status'; id: string; status: ElementStatus; correction?: unknown }
  | { op: 'reject_hypothesis'; id: string; reason?: string | undefined }
  | { op: 'set_layout'; diagram: string; positions: Record<string, LayoutBox> };

export const ModelOpSchema: z.ZodType<ModelOp> = z
  .discriminatedUnion('op', [
    z.strictObject({
      op: z.literal('add'),
      // L'id peut être temporaire (« tmp:3 ») ; le serveur le résout.
      element: z.lazy((): z.ZodType<Element> => ElementSchema),
    }),
    z.strictObject({
      op: z.literal('update'),
      id: ElementIdSchema,
      set: z.record(z.string(), z.unknown()),
      unset: z.array(z.string()).optional(),
    }),
    z.strictObject({
      op: z.literal('remove'),
      id: ElementIdSchema,
      cascade: z.array(ElementIdSchema).optional(),
    }),
    z.strictObject({
      op: z.literal('set_status'),
      id: ElementIdSchema,
      status: ElementStatusSchema,
      correction: z.unknown().optional(),
    }),
    z.strictObject({
      op: z.literal('reject_hypothesis'),
      id: ElementIdSchema,
      reason: z.string().optional(),
    }),
    z.strictObject({
      op: z.literal('set_layout'),
      diagram: DiagramIdSchema,
      positions: z.record(ElementIdSchema, LayoutBoxSchema),
    }),
  ])
  .meta({ id: 'ModelOp' });

export const CHANGE_CAUSES = [
  'extraction',
  'answer',
  'hypotheses',
  'hypothesis_decision',
  'process_flow',
  'dialogue_edit',
  'diagnostic',
  'optimisation',
  'validation',
  'rollback',
  'layout',
  'to_be_composition',
] as const;
export const ChangeCauseSchema = z.enum(CHANGE_CAUSES);
export type ChangeCause = z.infer<typeof ChangeCauseSchema>;

export interface ChangeSet {
  baseVersion: number;
  ops: ModelOp[];
  cause: ChangeCause;
  summary: string;
}

export const ChangeSetSchema: z.ZodType<ChangeSet> = z
  .strictObject({
    baseVersion: z.number().int().nonnegative(),
    ops: z.array(ModelOpSchema),
    cause: ChangeCauseSchema,
    summary: z.string().min(1),
  })
  .meta({ id: 'ChangeSet' });
