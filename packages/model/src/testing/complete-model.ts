import type { BusinessModel } from '../schema/business-model.js';
import {
  buildActivity,
  buildActor,
  buildBusinessTrait,
  buildDataField,
  buildDataObject,
  buildEvent,
  buildGateway,
  buildGlossaryTerm,
  buildIndicator,
  buildInformationFlow,
  buildModel,
  buildRule,
  buildSequenceFlow,
  buildTool,
  resetTestIds,
} from './factories.js';

/**
 * Modèle « complet » de test : complétude 1 pour chaque concept, aucun avertissement de cohérence,
 * valide pour `parseModel`. Déterministe. Un macroprocessus, un processus avec son enchaînement
 * (début, tâche, passerelle exclusive, fin, événement de bordure), une tâche et ses données.
 */
export function buildCompleteModel(): BusinessModel {
  resetTestIds();
  const traits = (['sector', 'environment', 'specificity', 'summary'] as const).map((facet) =>
    buildBusinessTrait({ label: facet, facet, text: `Texte ${facet}` }),
  );
  const term = buildGlossaryTerm({ label: 'Liasse' });
  const accountant = buildActor({ label: 'Comptable', category: 'internal' });
  const client = buildActor({ label: 'Client', category: 'external', stakeholder: true });
  const tool = buildTool({ label: 'Logiciel comptable' });
  const dossier = buildDataObject({
    label: 'Dossier client',
    nature: 'document',
    fields: [buildDataField({ name: 'Montant TTC' })],
    toolIds: [tool.id],
  });
  const piece = buildDataObject({
    label: 'Pièce justificative',
    nature: 'form',
    fields: [buildDataField({ name: 'Référence', type: 'text' })],
  });
  const macro = buildActivity({ label: 'Tenue comptable', level: 'macro', macroCategory: 'core' });
  const process = buildActivity({
    label: 'Relance des pièces manquantes',
    level: 'process',
    parentId: macro.id,
    responsibleActorId: accountant.id,
    raci: [
      { actorId: accountant.id, role: 'R' },
      { actorId: client.id, role: 'I' },
    ],
    inputs: [dossier.id],
    toolIds: [tool.id],
  });
  const task = buildActivity({
    label: 'Envoyer la relance',
    level: 'task',
    parentId: process.id,
    responsibleActorId: accountant.id,
    outputs: [piece.id],
  });
  const decisionRule = buildRule({
    label: 'Relance à 7 jours',
    type: 'decision',
    statement: { text: 'Relancer si la pièce manque', when: 'absente après 7 jours' },
  });
  const exceptionRule = buildRule({
    label: 'Client injoignable',
    type: 'exception',
    appliesTo: [task.id],
    exceptionHandling: {
      circuit: 'escalation',
      description: 'Escalade au responsable',
      activityIds: [task.id],
    },
  });
  const start = buildEvent({ label: 'Début', containerId: process.id, position: 'start' });
  const end = buildEvent({ label: 'Fin', containerId: process.id, position: 'end' });
  const timer = buildEvent({
    label: 'Délai dépassé',
    containerId: process.id,
    position: 'boundary',
    trigger: 'timer',
    attachedToId: task.id,
  });
  const gateway = buildGateway({
    label: 'Pièce reçue ?',
    containerId: process.id,
    ruleId: decisionRule.id,
  });
  const seq = (label: string, fromId: string, toId: string) =>
    buildSequenceFlow({ label, containerId: process.id, fromId, toId });
  const flows = [
    seq('Début vers tâche', start.id, task.id),
    seq('Tâche vers passerelle', task.id, gateway.id),
    seq('Passerelle vers fin', gateway.id, end.id),
    seq('Passerelle vers tâche', gateway.id, task.id),
    seq('Délai vers fin', timer.id, end.id),
  ];
  decisionRule.appliesTo = [gateway.id];
  const infoFlow = buildInformationFlow({
    label: 'Relance par courriel',
    fromActorId: accountant.id,
    toActorId: client.id,
    dataObjectIds: [dossier.id],
    channel: 'email',
    activityId: task.id,
  });
  const volume = buildIndicator({ label: 'Volume', targetId: process.id, measure: 'volume' });
  const delay = buildIndicator({
    label: 'Délai',
    targetId: process.id,
    measure: 'lead_time',
    value: { exact: 7 },
    unit: 'jours',
  });
  return buildModel([
    ...traits,
    term,
    accountant,
    client,
    tool,
    dossier,
    piece,
    macro,
    process,
    task,
    decisionRule,
    exceptionRule,
    start,
    end,
    timer,
    gateway,
    ...flows,
    infoFlow,
    volume,
    delay,
  ]);
}
