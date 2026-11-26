/**
 * Libellés écrits dans le BPMN pour les formes qui n'ont pas d'élément du modèle (titre du bassin,
 * couloir sans acteur, catégories du niveau 0…). Le paquet est pur et indépendant de l'i18n :
 * les valeurs par défaut sont en français, l'appelant peut les remplacer.
 */
export interface BpmnLabels {
  globalMap: string;
  organisation: string;
  unassignedLane: string;
  categories: { steering: string; core: string; support: string };
  linkNature: { sequence: string; feeds: string; steers: string; supports: string };
  rule: string;
  fields: string;
  required: string;
  personalData: string;
  timer: string;
  when: string;
  then: string;
  otherwise: string;
}

export const DEFAULT_LABELS: BpmnLabels = {
  globalMap: 'Cartographie globale',
  organisation: 'Organisation',
  unassignedLane: 'Non affecté',
  categories: { steering: 'Pilotage', core: 'Réalisation', support: 'Support' },
  linkNature: {
    sequence: 'Enchaînement',
    feeds: 'Alimente',
    steers: 'Pilote',
    supports: 'Supporte',
  },
  rule: 'Règle',
  fields: 'Champs',
  required: 'obligatoire',
  personalData: 'donnée personnelle',
  timer: 'Délai',
  when: 'Quand',
  then: 'Alors',
  otherwise: 'Sinon',
};
