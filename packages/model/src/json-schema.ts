import { z } from 'zod';
import { BusinessModelSchema } from './schema/business-model.js';

type JsonObject = Record<string, unknown>;

/** Éléments et sous-objets qui portent des provenance + statut (règles transverses de 2.1). */
const BASE_RULE_DEFS = [
  'BusinessTrait',
  'GlossaryTerm',
  'Actor',
  'Activity',
  'ProcessEvent',
  'Gateway',
  'SequenceFlow',
  'ProcessLink',
  'DataObject',
  'DataField',
  'Tool',
  'InformationFlow',
  'Rule',
  'Indicator',
  'Discrepancy',
  'Finding',
  'Optimisation',
] as const;

const prop = (name: string, schema: JsonObject): JsonObject => ({
  properties: { [name]: schema },
  required: [name],
});

/** Règles de dépendance entre champs que zod porte en `refine` et que JSON Schema exprime en if/then. */
const BASE_RULES: JsonObject[] = [
  {
    // extracted -> au moins une référence de source
    if: prop('status', prop('value', { const: 'extracted' })),
    then: prop('provenance', prop('refs', { minItems: 1 })),
  },
  {
    // hypothesis -> justification
    if: prop('status', prop('value', { const: 'hypothesis' })),
    then: prop('provenance', { required: ['rationale'] }),
  },
];

const EXTRA_RULES: Record<string, JsonObject[]> = {
  Activity: [
    {
      // hors macro -> parentId obligatoire
      if: prop('level', { not: { const: 'macro' } }),
      then: { required: ['parentId'] },
    },
  ],
  ProcessEvent: [
    {
      if: prop('position', { const: 'boundary' }),
      then: { required: ['attachedToId'] },
    },
  ],
  Discrepancy: [
    {
      if: prop('state', { const: 'resolved' }),
      then: { required: ['resolution'] },
    },
  ],
};

/**
 * JSON Schema (draft-07) du modèle métier. Généré depuis zod, puis complété par les règles que
 * zod exprime en `refine` (non exportables) : si/alors sur les statuts, la provenance, le niveau
 * d'activité, etc. Les contrôles propres à zod (clé = id de l'élément) ne figurent pas ici.
 */
export function buildBusinessModelJsonSchema(): JsonObject {
  const schema = z.toJSONSchema(BusinessModelSchema, {
    target: 'draft-7',
    unrepresentable: 'any',
    cycles: 'ref',
  }) as JsonObject;

  const defs = (schema.definitions ?? schema.$defs) as Record<string, JsonObject> | undefined;
  if (!defs) throw new Error('JSON Schema : définitions absentes');

  for (const name of BASE_RULE_DEFS) {
    const def = defs[name];
    if (!def) throw new Error(`JSON Schema : définition « ${name} » absente`);
    def.allOf = [...BASE_RULES, ...(EXTRA_RULES[name] ?? [])];
  }

  const provenance = defs.Provenance;
  if (!provenance) throw new Error('JSON Schema : définition « Provenance » absente');
  provenance.allOf = [
    {
      // ai_knowledge -> justification obligatoire
      if: prop('origin', { const: 'ai_knowledge' }),
      then: { required: ['rationale'] },
    },
  ];

  schema.$id = 'https://processia.local/schema/business-model.v1.json';
  schema.title = 'BusinessModel (schemaVersion 1)';
  return schema;
}
