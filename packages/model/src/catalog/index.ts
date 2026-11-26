import { z } from 'zod';
import catalogJson from './engine-capabilities.fr.json' with { type: 'json' };

/** Catalogue des capacités du moteur (spécification 2.6) [HORS-CDC, à confirmer PO-9]. */
export const AUTOMATION_TYPES = [
  'rules_notifications',
  'documents',
  'integration',
  'ai_agent',
] as const;
export const AutomationTypeSchema = z.enum(AUTOMATION_TYPES);
export type AutomationType = z.infer<typeof AutomationTypeSchema>;

export const EngineCapabilitySchema = z.strictObject({
  id: z.string().min(1),
  type: AutomationTypeSchema,
  label: z.string().min(1),
  description: z.string().min(1),
  effort: z.number().int().min(1).max(5),
});
export type EngineCapability = z.infer<typeof EngineCapabilitySchema>;

export const EngineCapabilityCatalogSchema = z.strictObject({
  version: z.literal(1),
  capabilities: z.array(EngineCapabilitySchema).min(1),
});

export const engineCapabilityCatalog = EngineCapabilityCatalogSchema.parse(catalogJson);

export const ENGINE_CAPABILITIES: readonly EngineCapability[] =
  engineCapabilityCatalog.capabilities;

/** Identifiants du catalogue, en tuple pour `z.enum`. */
export const ENGINE_CAPABILITY_IDS = ENGINE_CAPABILITIES.map((c) => c.id) as [string, ...string[]];

export const EngineCapabilityIdSchema = z.enum(ENGINE_CAPABILITY_IDS);
export type EngineCapabilityId = string;

export function getCapability(id: string): EngineCapability | undefined {
  return ENGINE_CAPABILITIES.find((c) => c.id === id);
}
