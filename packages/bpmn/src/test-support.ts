/** Jeux de test du paquet (exclus du build) : modèles minimal, complet et « riche » (réaliste). */
import {
  buildActivity,
  buildActor,
  buildCompleteModel,
  buildDataField,
  buildDataObject,
  buildEvent,
  buildGateway,
  buildInformationFlow,
  buildMinimalModel,
  buildModel,
  buildProcessLink,
  buildRule,
  buildSequenceFlow,
  resetTestIds,
  type BusinessModel,
  type Element,
} from '@processia/model';

export { buildCompleteModel, buildMinimalModel };

/**
 * Modèle riche : 3 macroprocessus, 3 processus (dont un sous-processus et un sans enchaînement),
 * acteurs internes et externes, événements de bord, passerelles avec boucle, agent IA, étapes (niveau 3).
 */
export function buildRichModel(): BusinessModel {
  resetTestIds();
  const compta = buildActor({ label: 'Comptable', category: 'internal' });
  const assistant = buildActor({ label: 'Assistant', category: 'internal' });
  const associe = buildActor({ label: 'Associé', category: 'internal' });
  const client = buildActor({ label: 'Client', category: 'external' });
  const banque = buildActor({ label: 'Banque', category: 'third_party_system' });
  const dossier = buildDataObject({
    label: 'Dossier client',
    nature: 'business_object',
    fields: [
      buildDataField({ name: 'Raison sociale', type: 'text', required: true }),
      buildDataField({ name: 'Contact', type: 'text', personalData: true }),
    ],
  });
  const piece = buildDataObject({ label: 'Pièce justificative', nature: 'document' });
  const releve = buildDataObject({ label: 'Relevé bancaire', nature: 'document' });
  const ruleDelay = buildRule({
    label: 'Délai de relance',
    type: 'decision',
    statement: { text: 'Relancer après 7 jours', when: 'pièce absente', then: 'relancer' },
  });
  const ruleExc = buildRule({ label: 'Client injoignable', type: 'exception' });

  const macroPilot = buildActivity({
    label: 'Pilotage',
    level: 'macro',
    macroCategory: 'steering',
  });
  const macroCore = buildActivity({
    label: 'Tenue comptable',
    level: 'macro',
    macroCategory: 'core',
  });
  const macroCore2 = buildActivity({ label: 'Révision', level: 'macro', macroCategory: 'core' });
  const macroSupport = buildActivity({
    label: 'Support',
    level: 'macro',
    macroCategory: 'support',
  });
  const macroFree = buildActivity({ label: 'Sans catégorie', level: 'macro' });
  const links = [
    buildProcessLink({ fromId: macroCore.id, toId: macroCore2.id, nature: 'sequence' }),
    buildProcessLink({ fromId: macroPilot.id, toId: macroCore.id, nature: 'steers' }),
    buildProcessLink({
      fromId: macroSupport.id,
      toId: macroCore.id,
      nature: 'supports',
      label: 'outils',
    }),
  ];

  const p1 = buildActivity({
    label: 'Relance des pièces manquantes',
    level: 'process',
    parentId: macroCore.id,
    order: 1,
    responsibleActorId: compta.id,
    raci: [
      { actorId: compta.id, role: 'R' },
      { actorId: client.id, role: 'I' },
    ],
  });
  const p2 = buildActivity({
    label: 'Saisie comptable',
    level: 'process',
    parentId: macroCore.id,
    order: 2,
    responsibleActorId: assistant.id,
  });
  const p3 = buildActivity({
    label: 'Clôture',
    level: 'process',
    parentId: macroCore.id,
    order: 3,
    responsibleActorId: associe.id,
  });
  const p4 = buildActivity({ label: 'Archivage', level: 'process', parentId: macroCore.id });
  const sub = buildActivity({
    label: 'Contrôle de la saisie',
    level: 'process',
    parentId: p2.id,
    responsibleActorId: associe.id,
  });

  // L2 de P1
  const t1 = buildActivity({
    label: 'Détecter la pièce manquante',
    level: 'task',
    parentId: p1.id,
    order: 1,
    execution: 'ai_agent',
    automation: { type: 'ai_agent', capability: 'document_classification' },
    responsibleActorId: assistant.id,
    inputs: [dossier.id],
    outputs: [piece.id],
  });
  const t2 = buildActivity({
    label: 'Envoyer la relance',
    level: 'task',
    parentId: p1.id,
    order: 2,
    execution: 'user',
    responsibleActorId: compta.id,
    inputs: [piece.id],
    ruleIds: [ruleDelay.id],
  });
  const t3 = buildActivity({
    label: 'Enregistrer la pièce',
    level: 'task',
    parentId: p1.id,
    order: 3,
    execution: 'automatic',
    responsibleActorId: assistant.id,
    outputs: [piece.id],
  });
  const t4 = buildActivity({
    label: 'Contacter la banque',
    level: 'task',
    parentId: p1.id,
    order: 4,
    execution: 'manual',
    responsibleActorId: compta.id,
    inputs: [releve.id],
  });
  const t5 = buildActivity({
    label: 'Escalader à l’associé',
    level: 'task',
    parentId: p1.id,
    order: 5,
    execution: 'manual',
    responsibleActorId: associe.id,
  });
  const steps = ['Rédiger le courriel', 'Joindre la liste', 'Valider', 'Envoyer'].map((label, i) =>
    buildActivity({
      label,
      level: 'step',
      parentId: t2.id,
      order: i + 1,
      execution: i === 2 ? 'user' : 'manual',
      inputs: i === 0 ? [dossier.id] : [],
      ruleIds: i === 0 ? [ruleDelay.id] : [],
    }),
  );
  const start = buildEvent({ label: 'Début', containerId: p1.id, position: 'start' });
  const msg = buildEvent({
    label: 'Pièce reçue',
    containerId: p1.id,
    position: 'intermediate',
    trigger: 'message',
  });
  const end = buildEvent({ label: 'Fin', containerId: p1.id, position: 'end' });
  const endEsc = buildEvent({
    label: 'Escaladé',
    containerId: p1.id,
    position: 'end',
    trigger: 'error',
  });
  const timer = buildEvent({
    label: 'Délai dépassé',
    containerId: p1.id,
    position: 'boundary',
    trigger: 'timer',
    attachedToId: t2.id,
    timer: 'J+7',
  });
  const timer2 = buildEvent({
    label: 'Sans réponse',
    containerId: p1.id,
    position: 'boundary',
    trigger: 'timer',
    attachedToId: t2.id,
  });
  const gw = buildGateway({ label: 'Pièce reçue ?', containerId: p1.id, ruleId: ruleDelay.id });
  const par = buildGateway({ label: 'En parallèle', containerId: p1.id, type: 'parallel' });
  const join = buildGateway({ label: 'Fin des contrôles', containerId: p1.id, type: 'parallel' });
  const seq = (
    from: Element,
    to: Element,
    extra: Partial<Parameters<typeof buildSequenceFlow>[0]> = {},
  ) => buildSequenceFlow({ containerId: p1.id, fromId: from.id, toId: to.id, ...extra });
  const flows = [
    seq(start, t1),
    seq(t1, gw),
    seq(gw, t3, { condition: 'Pièce reçue', isDefault: true }),
    seq(gw, t2, { condition: 'Pièce absente' }),
    seq(t2, msg),
    seq(msg, gw),
    seq(t3, par),
    seq(par, t4),
    seq(par, t5),
    seq(t4, join),
    seq(t5, join),
    seq(join, end),
    seq(timer, endEsc),
    seq(timer2, t5),
  ];
  // L3 de T2 : un enchaînement par l'ordre, une exception en bordure d'une étape.
  const stepBoundary = buildEvent({
    label: 'Courriel rejeté',
    containerId: t2.id,
    position: 'boundary',
    trigger: 'error',
    attachedToId: (steps[3] as Element).id,
  });
  const stepEnd = buildEvent({ label: 'Courriel envoyé', containerId: t2.id, position: 'end' });
  const stepFlow = buildSequenceFlow({
    containerId: t2.id,
    fromId: stepBoundary.id,
    toId: stepEnd.id,
  });

  // L2 de P3 : aucun enchaînement dans le modèle, une tâche sans acteur.
  const q1 = buildActivity({
    label: 'Préparer la liasse',
    level: 'task',
    parentId: p3.id,
    order: 1,
  });
  const q2 = buildActivity({
    label: 'Signer',
    level: 'task',
    parentId: p3.id,
    order: 2,
    execution: 'user',
  });

  const infoFlows = [
    buildInformationFlow({
      label: 'Relance',
      fromActorId: compta.id,
      toActorId: client.id,
      activityId: t2.id,
      dataObjectIds: [piece.id],
    }),
    buildInformationFlow({
      label: 'Pièce du client',
      fromActorId: client.id,
      toActorId: assistant.id,
      activityId: t3.id,
      dataObjectIds: [piece.id],
    }),
    buildInformationFlow({
      label: 'Demande de relevé',
      fromActorId: compta.id,
      toActorId: banque.id,
      activityId: t4.id,
      dataObjectIds: [releve.id],
    }),
    buildInformationFlow({
      label: 'Note interne',
      fromActorId: compta.id,
      toActorId: associe.id,
      activityId: t1.id,
    }),
  ];

  const elements: Element[] = [
    compta,
    assistant,
    associe,
    client,
    banque,
    dossier,
    piece,
    releve,
    ruleDelay,
    ruleExc,
    macroPilot,
    macroCore,
    macroCore2,
    macroSupport,
    macroFree,
    ...links,
    p1,
    p2,
    p3,
    p4,
    sub,
    t1,
    t2,
    t3,
    t4,
    t5,
    ...steps,
    q1,
    q2,
    start,
    msg,
    end,
    endEsc,
    timer,
    timer2,
    gw,
    par,
    join,
    stepBoundary,
    stepEnd,
    ...flows,
    stepFlow,
    ...infoFlows,
  ];
  return buildModel(elements);
}

/** Ajoute une tâche à P1 (enchaînée entre t3 et la passerelle) : modèle de la version suivante. */
export function addTaskToRichModel(model: BusinessModel): { model: BusinessModel; taskId: string } {
  const acts = Object.values(model.elements).filter(
    (e): e is Extract<Element, { kind: 'activity' }> => e.kind === 'activity',
  );
  const p1 = acts.find((a) => a.label === 'Relance des pièces manquantes') as Element;
  const compta = Object.values(model.elements).find((e) => e.label === 'Comptable') as Element;
  const gw = Object.values(model.elements).find((e) => e.label === 'En parallèle') as Element;
  const t3 = acts.find((a) => a.label === 'Enregistrer la pièce') as Element;
  const task = buildActivity({
    id: '01900000-0fff-7000-8000-000000000001',
    code: 'P-NEW',
    label: 'Archiver la pièce',
    level: 'task',
    parentId: p1.id,
    order: 6,
    execution: 'user',
    responsibleActorId: compta.id,
  });
  const f1 = buildSequenceFlow({
    id: '01900000-0fff-7000-8000-000000000002',
    code: 'SEQ-NEW1',
    containerId: p1.id,
    fromId: t3.id,
    toId: task.id,
  });
  const f2 = buildSequenceFlow({
    id: '01900000-0fff-7000-8000-000000000003',
    code: 'SEQ-NEW2',
    containerId: p1.id,
    fromId: task.id,
    toId: gw.id,
  });
  const elements = { ...model.elements, [task.id]: task, [f1.id]: f1, [f2.id]: f2 };
  // On remplace le flux t3 → passerelle parallèle par t3 → nouvelle tâche → passerelle.
  for (const e of Object.values(model.elements)) {
    if (e.kind === 'sequence_flow' && e.fromId === t3.id && e.toId === gw.id) delete elements[e.id];
  }
  return { model: { ...model, version: model.version + 1, elements }, taskId: task.id };
}
