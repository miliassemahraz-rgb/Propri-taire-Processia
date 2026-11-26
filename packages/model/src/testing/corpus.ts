import type { BusinessModel } from '../schema/business-model.js';
import type { Element } from '../schema/element.js';
import { buildSourceRef } from './factories.js';
import { buildMinimalModel } from './minimal-model.js';

/**
 * Jeux de test partagés entre la validation zod et le JSON Schema (acceptation WP-02, critères 2 et 3).
 * Chaque cas part d'une copie du modèle minimal.
 */
export interface CorpusCase {
  name: string;
  valid: boolean;
  /** Fin attendue du chemin d'erreur zod (cas invalides). */
  pathEndsWith?: string;
  mutate: (model: BusinessModel) => unknown;
}

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function find(model: BusinessModel, kind: Element['kind'], label?: string): Loose {
  const found = Object.values(model.elements).find(
    (e) => e.kind === kind && (label === undefined || e.label === label),
  );
  if (!found) throw new Error(`Élément ${kind}/${label ?? '*'} introuvable dans le modèle minimal`);
  return found as Loose;
}

const edit =
  (kind: Element['kind'], label: string | undefined, fn: (e: Loose) => void) =>
  (model: BusinessModel): unknown => {
    fn(find(model, kind, label));
    return model;
  };

export function cloneMinimal(): BusinessModel {
  return structuredClone(buildMinimalModel());
}

export const CORPUS: CorpusCase[] = [
  { name: 'modèle minimal (16 types d’éléments)', valid: true, mutate: (m) => m },
  {
    name: 'hypothèse justifiée',
    valid: true,
    mutate: edit('glossary_term', 'Liasse', (e) => {
      e.provenance.rationale = 'Autre justification';
    }),
  },
  {
    name: 'macroprocessus sans parent',
    valid: true,
    mutate: edit('activity', 'Pilotage', (e) => {
      delete e.parentId;
    }),
  },
  {
    name: 'extracted sans référence de source',
    valid: false,
    pathEndsWith: 'provenance.refs',
    mutate: edit('business_trait', 'Secteur', (e) => {
      e.provenance.refs = [];
    }),
  },
  {
    name: 'ai_knowledge sans justification',
    valid: false,
    pathEndsWith: 'provenance.rationale',
    mutate: edit('glossary_term', 'Liasse', (e) => {
      e.status.value = 'confirmed';
      delete e.provenance.rationale;
    }),
  },
  {
    name: 'hypothèse sans justification',
    valid: false,
    pathEndsWith: 'provenance.rationale',
    mutate: edit('glossary_term', 'Liasse', (e) => {
      e.provenance.origin = 'consultant';
      delete e.provenance.rationale;
    }),
  },
  {
    name: 'processus sans parent',
    valid: false,
    pathEndsWith: 'parentId',
    mutate: edit('activity', 'Relance des pièces manquantes', (e) => {
      delete e.parentId;
    }),
  },
  {
    name: 'étape sans parent',
    valid: false,
    pathEndsWith: 'parentId',
    mutate: edit('activity', 'Rédiger le courriel', (e) => {
      delete e.parentId;
    }),
  },
  {
    name: 'optimisation sans constat',
    valid: false,
    pathEndsWith: 'findingIds',
    mutate: edit('optimisation', undefined, (e) => {
      e.findingIds = [];
    }),
  },
  {
    name: 'événement de bordure sans rattachement',
    valid: false,
    pathEndsWith: 'attachedToId',
    mutate: edit('event', 'Délai dépassé', (e) => {
      delete e.attachedToId;
    }),
  },
  {
    name: 'écart résolu sans résolution',
    valid: false,
    pathEndsWith: 'resolution',
    mutate: edit('discrepancy', undefined, (e) => {
      e.state = 'resolved';
    }),
  },
  {
    name: 'écart avec un seul côté',
    valid: false,
    pathEndsWith: 'sides',
    mutate: edit('discrepancy', undefined, (e) => {
      e.sides = [e.sides[0]];
    }),
  },
  {
    name: 'constat sans localisation',
    valid: false,
    pathEndsWith: 'location',
    mutate: edit('finding', undefined, (e) => {
      e.location = [];
    }),
  },
  {
    name: 'champ de donnée extracted sans référence',
    valid: false,
    pathEndsWith: 'provenance.refs',
    mutate: edit('data_object', undefined, (e) => {
      e.fields[0].status.value = 'extracted';
    }),
  },
  {
    name: 'capacité hors catalogue',
    valid: false,
    pathEndsWith: 'automation.capability',
    mutate: edit('activity', 'Envoyer la relance', (e) => {
      e.automation.capability = 'teleportation';
    }),
  },
  {
    name: 'confiance hors de 0..1',
    valid: false,
    pathEndsWith: 'provenance.confidence',
    mutate: edit('business_trait', 'Secteur', (e) => {
      e.provenance.confidence = 2;
    }),
  },
  {
    name: 'table de décision réservée',
    valid: false,
    pathEndsWith: 'decisionTable',
    mutate: edit('rule', undefined, (e) => {
      e.decisionTable = { rows: [] };
    }),
  },
  {
    name: 'date invalide',
    valid: false,
    pathEndsWith: 'provenance.at',
    mutate: edit('actor', 'Comptable', (e) => {
      e.provenance.at = 'hier';
    }),
  },
  {
    name: 'propriété inconnue',
    valid: false,
    mutate: edit('tool', undefined, (e) => {
      e.colour = 'rouge';
    }),
  },
  {
    name: 'libellé manquant',
    valid: false,
    pathEndsWith: 'label',
    mutate: edit('actor', 'Client', (e) => {
      delete e.label;
    }),
  },
  {
    name: 'type d’élément inconnu',
    valid: false,
    mutate: edit('tool', undefined, (e) => {
      e.kind = 'gadget';
    }),
  },
  {
    name: 'opération inconnue dans le ChangeSet d’une optimisation',
    valid: false,
    mutate: edit('optimisation', undefined, (e) => {
      e.changeSet.ops = [{ op: 'explode' }];
    }),
  },
  {
    name: 'ajout invalide dans le ChangeSet d’une optimisation (activité sans parent)',
    valid: false,
    pathEndsWith: 'parentId',
    mutate: edit('optimisation', undefined, (e) => {
      const add = e.changeSet.ops.find((op: Loose) => op.op === 'add');
      delete add.element.parentId;
    }),
  },
  {
    name: 'identifiant qui n’est pas un UUID v7',
    valid: false,
    mutate: edit('actor', 'Client', (e) => {
      e.responsibilities = [];
      e.parentId = 'pas-un-uuid';
    }),
  },
  {
    name: 'version de schéma inconnue',
    valid: false,
    pathEndsWith: 'schemaVersion',
    mutate: (m) => ({ ...m, schemaVersion: 2 }),
  },
  {
    name: 'référence de source valide ajoutée',
    valid: true,
    mutate: edit('business_trait', 'Secteur', (e) => {
      e.provenance.refs.push(buildSourceRef({ quote: 'Autre citation' }));
    }),
  },
];
