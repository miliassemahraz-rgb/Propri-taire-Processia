import { tempId } from '../ids.js';
import type { BusinessModel } from '../schema/business-model.js';
import {
  buildActivity,
  buildActor,
  buildBusinessTrait,
  buildDataField,
  buildDataObject,
  buildDiscrepancy,
  buildEvent,
  buildFinding,
  buildGateway,
  buildGlossaryTerm,
  buildIndicator,
  buildInformationFlow,
  buildModel,
  buildOptimisation,
  buildProcessLink,
  buildProvenance,
  buildRule,
  buildSequenceFlow,
  buildSourceRef,
  buildStatus,
  buildTool,
  resetTestIds,
} from './factories.js';

/**
 * Modèle minimal valide couvrant les 16 types d'éléments (acceptation WP-02, critère 1).
 * Déterministe : `fixtures/minimal-model.json` en est la sérialisation (vérifié par un test).
 * Scénario : un cabinet comptable, macroprocessus « Relance des pièces manquantes ».
 */
export function buildMinimalModel(): BusinessModel {
  resetTestIds();
  const extractedProvenance = buildProvenance({
    origin: 'document',
    refs: [buildSourceRef()],
    author: { type: 'ai' },
    confidence: 0.9,
  });
  const extracted = {
    provenance: extractedProvenance,
    status: buildStatus({ value: 'extracted' }),
  };
  const hypothesis = {
    provenance: buildProvenance({
      origin: 'ai_knowledge',
      rationale: 'Usage courant dans la profession',
      author: { type: 'ai' },
    }),
    status: buildStatus({ value: 'hypothesis' }),
  };

  const trait = buildBusinessTrait({ label: 'Secteur', ...extracted });
  const term = buildGlossaryTerm({ label: 'Liasse', ...hypothesis });
  const accountant = buildActor({ label: 'Comptable', category: 'internal' });
  const client = buildActor({ label: 'Client', category: 'external', stakeholder: true });
  const tool = buildTool({ label: 'Logiciel comptable' });
  const dossier = buildDataObject({
    label: 'Dossier client',
    nature: 'business_object',
    fields: [buildDataField({ name: 'Montant TTC', type: 'amount' })],
    toolIds: [tool.id],
  });
  const rule = buildRule({
    label: 'Relance à 7 jours',
    type: 'decision',
    statement: {
      text: 'Relancer le client si la pièce manque',
      when: 'pièce absente après 7 jours',
      then: 'envoyer une relance',
    },
  });

  const macro1 = buildActivity({ label: 'Tenue comptable', level: 'macro', macroCategory: 'core' });
  const macro2 = buildActivity({ label: 'Pilotage', level: 'macro', macroCategory: 'steering' });
  const process = buildActivity({
    label: 'Relance des pièces manquantes',
    level: 'process',
    parentId: macro1.id,
    responsibleActorId: accountant.id,
    raci: [{ actorId: accountant.id, role: 'R' }],
    inputs: [dossier.id],
    toolIds: [tool.id],
    ruleIds: [rule.id],
    scope: 'application',
  });
  const task = buildActivity({
    label: 'Envoyer la relance',
    level: 'task',
    parentId: process.id,
    responsibleActorId: accountant.id,
    execution: 'user',
    automation: { type: 'rules_notifications', capability: 'reminder' },
  });
  const step = buildActivity({
    label: 'Rédiger le courriel',
    level: 'step',
    parentId: task.id,
    order: 1,
  });
  const start = buildEvent({ label: 'Début', containerId: process.id, position: 'start' });
  const end = buildEvent({ label: 'Fin', containerId: process.id, position: 'end' });
  const timer = buildEvent({
    label: 'Délai dépassé',
    containerId: process.id,
    position: 'boundary',
    trigger: 'timer',
    attachedToId: task.id,
    timer: 'J+7 après la demande',
  });
  const gateway = buildGateway({
    label: 'Pièce reçue ?',
    containerId: process.id,
    ruleId: rule.id,
    actorId: accountant.id,
  });
  const flow = buildSequenceFlow({
    label: 'Début vers tâche',
    containerId: process.id,
    fromId: start.id,
    toId: task.id,
  });
  const flow2 = buildSequenceFlow({
    label: 'Tâche vers passerelle',
    containerId: process.id,
    fromId: task.id,
    toId: gateway.id,
    condition: 'toujours',
    isDefault: true,
  });
  const link = buildProcessLink({
    label: 'Pilotage vers tenue',
    fromId: macro2.id,
    toId: macro1.id,
    nature: 'steers',
    dataObjectIds: [dossier.id],
  });
  const infoFlow = buildInformationFlow({
    label: 'Relance par courriel',
    fromActorId: accountant.id,
    toActorId: client.id,
    dataObjectIds: [dossier.id],
    channel: 'email',
    activityId: task.id,
  });
  const indicator = buildIndicator({
    label: 'Volume mensuel',
    targetId: process.id,
    ...extracted,
  });
  const discrepancy = buildDiscrepancy({
    label: 'Délai de relance',
    elementIds: [rule.id],
    ...hypothesis,
  });
  const finding = buildFinding({
    label: 'Ressaisie des pièces',
    location: [task.id],
    provenance: buildProvenance({ origin: 'deterministic_rule', author: { type: 'system' } }),
  });
  const optimisation = buildOptimisation({
    label: 'Relance automatique',
    findingIds: [finding.id],
    touchedElementIds: [task.id],
    changeSet: {
      baseVersion: 1,
      cause: 'optimisation',
      summary: 'Automatiser la relance',
      ops: [
        { op: 'update', id: task.id, set: { execution: 'automatic' } },
        {
          op: 'add',
          element: buildActivity({
            id: tempId(1),
            label: 'Relance automatique',
            level: 'step',
            parentId: task.id,
          }),
        },
      ],
    },
    automationType: 'rules_notifications',
  });
  const rejected = buildGlossaryTerm({
    label: 'Terme rejeté',
    term: 'Bilan',
    definition: 'Hypothèse écartée',
    ...hypothesis,
  });

  const model = buildModel(
    [
      trait,
      term,
      accountant,
      client,
      tool,
      dossier,
      rule,
      macro1,
      macro2,
      process,
      task,
      step,
      start,
      end,
      timer,
      gateway,
      flow,
      flow2,
      link,
      infoFlow,
      indicator,
      discrepancy,
      finding,
      optimisation,
    ],
    {
      rejectedHypotheses: [
        {
          element: rejected,
          by: 'user-1',
          at: '2026-01-16T09:00:00.000Z',
          reason: 'Hors périmètre',
        },
      ],
      layout: { L0: { [macro1.id]: { x: 0, y: 0, w: 120, h: 60 } } },
    },
  );
  return model;
}
