import { z } from 'zod';
import { CURRENT_SCHEMA_VERSION } from '../migrations/index.js';
import { LayoutBoxSchema } from './change-set.js';
import { ElementSchema } from './element.js';
import {
  DiagramIdSchema,
  ISODateTimeSchema,
  PersistentElementIdSchema,
  UserIdSchema,
} from './ids.js';

export const RejectedHypothesisSchema = z.strictObject({
  element: ElementSchema,
  by: UserIdSchema,
  at: ISODateTimeSchema,
  reason: z.string().optional(),
});
export type RejectedHypothesis = z.infer<typeof RejectedHypothesisSchema>;

export const BusinessModelSchema = z
  .strictObject({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    missionId: z.string().min(1),
    version: z.number().int().positive(),
    elements: z.record(PersistentElementIdSchema, ElementSchema),
    rejectedHypotheses: z.array(RejectedHypothesisSchema),
    layout: z.record(DiagramIdSchema, z.record(PersistentElementIdSchema, LayoutBoxSchema)),
  })
  // Contrôle propre à zod (non exprimable en JSON Schema) : la clé de la table est l'id de l'élément.
  .superRefine((model, ctx) => {
    for (const [key, element] of Object.entries(model.elements)) {
      if (element.id !== key) {
        ctx.addIssue({
          code: 'custom',
          path: ['elements', key, 'id'],
          message: `L'id de l'élément (${element.id}) diffère de sa clé (${key})`,
        });
      }
    }
  })
  .meta({ id: 'BusinessModel' });
export type BusinessModel = z.infer<typeof BusinessModelSchema>;
