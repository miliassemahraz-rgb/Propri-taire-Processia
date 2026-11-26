import { z } from 'zod';
import { ActivitySchema } from './activity.js';
import { ActorSchema } from './actor.js';
import { BusinessTraitSchema } from './business-trait.js';
import { DataObjectSchema } from './data-object.js';
import { DiscrepancySchema } from './discrepancy.js';
import { ProcessEventSchema } from './event.js';
import { FindingSchema } from './finding.js';
import { GatewaySchema } from './gateway.js';
import { GlossaryTermSchema } from './glossary-term.js';
import { IndicatorSchema } from './indicator.js';
import { InformationFlowSchema } from './information-flow.js';
import { OptimisationSchema } from './optimisation.js';
import { ProcessLinkSchema } from './process-link.js';
import { RuleSchema } from './rule.js';
import { SequenceFlowSchema } from './sequence-flow.js';
import { ToolSchema } from './tool.js';

/** Union discriminée par `kind` (spécification 2.5). */
export const ElementSchema = z
  .discriminatedUnion('kind', [
    BusinessTraitSchema,
    GlossaryTermSchema,
    ActorSchema,
    ActivitySchema,
    ProcessEventSchema,
    GatewaySchema,
    SequenceFlowSchema,
    ProcessLinkSchema,
    DataObjectSchema,
    ToolSchema,
    InformationFlowSchema,
    RuleSchema,
    IndicatorSchema,
    DiscrepancySchema,
    FindingSchema,
    OptimisationSchema,
  ])
  .meta({ id: 'Element' });
export type Element = z.infer<typeof ElementSchema>;
