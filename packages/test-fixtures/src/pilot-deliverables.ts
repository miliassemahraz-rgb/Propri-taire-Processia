/**
 * Saisies du consultant sur le modèle du pilote pour les livrables de l'étape 1 (WP-15) : le
 * scénario factice du pilote extrait des activités, des acteurs et des outils, mais ni objets de
 * données, ni flux, ni règles, ni RACI (WP-17 et suivants). Ce ChangeSet les ajoute, en éléments
 * `confirmed` saisis par un consultant, pour que les quatre livrables soient tous renseignés
 * dans les tests d'acceptation et dans les échantillons remis au PO.
 */
import type { ChangeSet, Element, Provenance, StatusInfo } from '@processia/model';

export interface PilotDeliverablesInput {
  baseVersion: number;
  /** Identifiant du consultant qui saisit. */
  userId: string;
  /** Instant de la saisie (ISO). */
  at: string;
  /** Identifiant (persistant) de l'élément du modèle de ce libellé. */
  idOf: (label: string) => string;
}

/** Identifiants persistants des champs : un champ n'accepte pas d'identifiant temporaire. */
export const PILOT_FIELD_IDS = {
  companyName: '01900000-0000-7000-8000-0000000000f1',
  vatRegime: '01900000-0000-7000-8000-0000000000f2',
} as const;

export function pilotDeliverablesChangeSet(input: PilotDeliverablesInput): ChangeSet {
  const { userId, at, idOf } = input;
  const provenance: Provenance = {
    origin: 'consultant',
    refs: [],
    author: { type: 'user', userId },
    at,
  };
  const status: StatusInfo = { value: 'confirmed', decidedBy: userId, decidedAt: at };
  const meta = { createdInVersion: 0, updatedInVersion: 0 };
  const common = { provenance, status, meta };

  const dossier: Element = {
    ...common,
    id: 'tmp:1',
    code: 'DON-01',
    label: 'Dossier client',
    kind: 'data_object',
    nature: 'business_object',
    toolIds: [idOf('Logiciel comptable')],
    personalData: true,
    lifecycleStates: ['Ouvert', 'En cours', 'Clôturé'],
    fields: [
      {
        id: PILOT_FIELD_IDS.companyName,
        name: 'Raison sociale',
        type: 'text',
        required: true,
        provenance,
        status,
      },
      {
        id: PILOT_FIELD_IDS.vatRegime,
        name: 'Régime de TVA',
        type: 'enum',
        enumValues: ['Réel normal', 'Réel simplifié', 'Franchise'],
        provenance,
        status,
      },
    ],
  };
  const flow: Element = {
    ...common,
    id: 'tmp:2',
    code: 'FLX-01',
    label: 'Transmission des pièces',
    kind: 'information_flow',
    fromActorId: idOf('Client du cabinet'),
    toActorId: idOf('Collaborateur comptable'),
    dataObjectIds: ['tmp:1'],
    channel: 'portal',
    activityId: idOf('Collecte documentaire'),
    frequency: 'chaque mois',
  };
  const decision: Element = {
    ...common,
    id: 'tmp:3',
    code: 'RG-001',
    label: 'Relance des pièces manquantes',
    kind: 'rule',
    type: 'decision',
    statement: {
      text: 'Une pièce manquante est relancée.',
      when: 'La pièce n’est pas reçue sous 7 jours',
      then: 'Envoyer une relance au client',
      otherwise: 'Poursuivre la saisie',
    },
    appliesTo: [idOf('Collecte documentaire')],
  };
  const exception: Element = {
    ...common,
    id: 'tmp:4',
    code: 'RG-002',
    label: 'Client injoignable',
    kind: 'rule',
    type: 'exception',
    statement: { text: 'Après trois relances sans réponse, le dossier est escaladé.' },
    appliesTo: [idOf('Collecte documentaire')],
    dependsOn: ['tmp:3'],
    exceptionHandling: { circuit: 'escalation', description: 'Escalade au chef de mission' },
    legalReference: 'Code de déontologie, article 12',
  };
  return {
    baseVersion: input.baseVersion,
    cause: 'dialogue_edit',
    summary: 'Données, flux, règles et RACI saisis par le consultant',
    ops: [
      ...[dossier, flow, decision, exception].map((element) => ({ op: 'add' as const, element })),
      {
        op: 'update',
        id: idOf('Production comptable'),
        set: {
          raci: [
            { actorId: idOf('Collaborateur comptable'), role: 'R' },
            { actorId: idOf('Expert-comptable'), role: 'A' },
            { actorId: idOf('Chef de mission'), role: 'C' },
            { actorId: idOf('Client du cabinet'), role: 'I' },
          ],
        },
      },
    ],
  };
}
