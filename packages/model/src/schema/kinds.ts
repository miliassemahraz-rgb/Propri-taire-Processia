import { z } from 'zod';

export const ELEMENT_KINDS = [
  'business_trait',
  'glossary_term',
  'actor',
  'activity',
  'event',
  'gateway',
  'sequence_flow',
  'process_link',
  'data_object',
  'tool',
  'information_flow',
  'rule',
  'indicator',
  'discrepancy',
  'finding',
  'optimisation',
] as const;
export const ElementKindSchema = z.enum(ELEMENT_KINDS);
export type ElementKind = z.infer<typeof ElementKindSchema>;

export const CONCEPTS = [
  'business',
  'actors',
  'activities',
  'data',
  'flows',
  'rules',
  'indicators',
] as const;
export const ConceptSchema = z.enum(CONCEPTS);
export type Concept = z.infer<typeof ConceptSchema>;

export const CONCEPT_OF_KIND: Record<
  Exclude<ElementKind, 'discrepancy' | 'finding' | 'optimisation'>,
  Concept
> = {
  business_trait: 'business',
  glossary_term: 'business',
  actor: 'actors',
  activity: 'activities',
  event: 'activities',
  gateway: 'activities',
  sequence_flow: 'activities',
  process_link: 'activities',
  data_object: 'data',
  tool: 'data',
  information_flow: 'flows',
  rule: 'rules',
  indicator: 'indicators',
};
