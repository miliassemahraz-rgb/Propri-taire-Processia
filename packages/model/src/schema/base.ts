import { z } from 'zod';
import { CodeSchema, ElementIdSchema, LabelSchema } from './ids.js';
import { ProvenanceSchema, StatusInfoSchema } from './provenance.js';

/** Champs communs à tous les éléments (spécification 2.2), sans `kind`. */
export const baseShape = {
  id: ElementIdSchema,
  code: CodeSchema,
  label: LabelSchema,
  description: z.string().optional(),
  provenance: ProvenanceSchema,
  fieldProvenance: z.record(z.string(), ProvenanceSchema).optional(),
  status: StatusInfoSchema,
  tags: z.array(z.string()).optional(),
  meta: z.strictObject({
    createdInVersion: z.number().int().nonnegative(),
    updatedInVersion: z.number().int().nonnegative(),
  }),
} as const;

interface WithBase {
  status: { value: string };
  provenance: { refs: unknown[]; rationale?: string | undefined };
}

/**
 * Règles transverses (spécification 2.1) : un élément `extracted` cite au moins une source ;
 * un élément `hypothesis` porte une justification. Les mêmes règles sont réécrites en JSON Schema
 * (`json-schema.ts`) ; la parité est vérifiée par les tests.
 */
export function withBaseRules<S extends z.ZodType<WithBase>>(schema: S): S {
  return schema
    .refine((e) => e.status.value !== 'extracted' || e.provenance.refs.length >= 1, {
      path: ['provenance', 'refs'],
      message: 'Un élément extracted exige au moins une référence de source',
    })
    .refine((e) => e.status.value !== 'hypothesis' || e.provenance.rationale !== undefined, {
      path: ['provenance', 'rationale'],
      message: 'Une hypothèse exige une justification (rationale)',
    }) as S;
}
