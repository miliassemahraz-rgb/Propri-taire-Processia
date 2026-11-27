/**
 * Scénario factice du pilote pour `process.flow` (WP-17) : un enchaînement plausible pour chacun
 * des processus de P01 à P14 (début, tâches, point de décision pour les processus couverts par
 * l'application, fin) et le niveau 3 de l'exemple du CDC 4.1 « Relance des pièces manquantes »
 * (P04) avec ses champs, ses délais, ses destinataires, ses indicateurs et ses règles. Les sorties
 * respectent le contrôle sémantique du pipeline (graphes sains, acteurs connus).
 */
import { PILOT_MACROS, type ScenarioRequest } from './pilot.js';

const canon = (s: string): string =>
  s.normalize('NFC').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();

const DONNEES_RE = /<donnees>\n([\s\S]*?)\n<\/donnees>/;

interface TaskInfo {
  code: string;
  label: string;
  actor?: string;
}
interface FlowData {
  mode: 'flow' | 'detail';
  process: { code: string; label: string; macro: string };
  tasks: TaskInfo[];
  detailTasks: TaskInfo[];
  actors: { code: string; label: string }[];
}

/** Libellé de la tâche d'exemple du CDC 4.1 et du processus qui la porte. */
export const PILOT_RELANCE_PROCESS = 'Relances clients';
export const PILOT_RELANCE_TASK = 'Relance des pièces manquantes';

/** Acteur principal de chaque macroprocessus (CDC 8.2 et 8.3). */
const MACRO_ACTOR: Record<string, string> = {
  'prospection commerciale': 'Responsable commercial',
  'entrée en relation client': 'Responsable commercial',
  'gestion du portefeuille clients': 'Chef de mission',
  'collecte documentaire': 'Assistant administratif',
  'production comptable': 'Collaborateur comptable',
  'révision comptable': 'Chef de mission',
  'gestion fiscale': 'Collaborateur comptable',
  'gestion sociale': 'Gestionnaire de paie',
  'clôture comptable': 'Collaborateur comptable',
  'validation et supervision': 'Expert-comptable',
  'conseil et accompagnement': 'Expert-comptable',
  'facturation et recouvrement': 'Assistant administratif',
  'archivage et conformité': 'Administrateur du système',
  'pilotage du cabinet': 'Chef de mission',
};

/** Macroprocessus couverts par l'application : leur enchaînement comporte un contrôle. */
const APPLICATION_MACROS = new Set(
  PILOT_MACROS.filter((m) => m.scope === 'application').map((m) => canon(m.label)),
);

function parse(req: ScenarioRequest): FlowData | null {
  const content = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const m = DONNEES_RE.exec(content);
  return m === null ? null : (JSON.parse(m[1] as string) as FlowData);
}

const empty = {
  nodes: [],
  edges: [],
  rules: [],
  dataObjects: [],
  indicators: [],
  informationFlows: [],
  rationale: 'Aucun enchaînement à proposer.',
};

function actorFor(data: FlowData): string {
  const labels = new Set(data.actors.map((a) => a.label));
  const preferred = MACRO_ACTOR[canon(data.process.macro)];
  if (preferred !== undefined && labels.has(preferred)) return preferred;
  return data.actors[0]?.label ?? '';
}

type Obj = Record<string, unknown>;

const event = (
  ref: string,
  container: string,
  label: string,
  position: string,
  extra: Obj = {},
): Obj => ({
  ref,
  container,
  kind: 'event',
  label,
  position,
  trigger: 'none',
  rationale: 'Événement usuel pour borner le processus.',
  ...extra,
});

// ------------------------------------------------------------------ niveau 2

function relancesFlow(data: FlowData, actor: string): unknown {
  const task = (ref: string, label: string, description: string): Obj => ({
    ref,
    container: 'process',
    kind: 'task',
    label,
    description,
    actor,
    execution: 'manual',
    rationale:
      'Étape usuelle de la collecte documentaire d’un cabinet d’expertise comptable (hypothèse de l’outil).',
  });
  return {
    nodes: [
      event('start', 'process', 'Pièces attendues du dossier', 'start'),
      task(
        't1',
        'Identifier les pièces manquantes',
        'Comparer les pièces reçues à la liste attendue.',
      ),
      task('t2', PILOT_RELANCE_TASK, 'Relancer le client jusqu’à réception des pièces.'),
      event('wait', 'process', 'Attendre la réponse du client', 'intermediate', {
        trigger: 'timer',
        timer: 'J+7 après la relance',
        rationale: 'Un délai de réponse est laissé au client avant de contrôler la réception.',
      }),
      {
        ref: 'gw',
        container: 'process',
        kind: 'gateway',
        label: 'Pièces reçues ?',
        gatewayType: 'exclusive',
        rule: 'r1',
        actor,
        rationale: 'La suite dépend de la réception des pièces.',
      },
      task(
        't3',
        'Réceptionner et classer les pièces',
        'Classer les pièces reçues dans le dossier client.',
      ),
      event('end', 'process', 'Pièces complètes', 'end'),
    ],
    edges: [
      { container: 'process', from: 'start', to: 't1' },
      { container: 'process', from: 't1', to: 't2' },
      { container: 'process', from: 't2', to: 'wait' },
      { container: 'process', from: 'wait', to: 'gw' },
      { container: 'process', from: 'gw', to: 't3', condition: 'Pièces reçues', isDefault: true },
      { container: 'process', from: 'gw', to: 't2', condition: 'Pièces toujours manquantes' },
      { container: 'process', from: 't3', to: 'end' },
    ],
    rules: [
      {
        ref: 'r1',
        type: 'decision',
        label: 'Réception des pièces',
        text: 'Une pièce non reçue après le délai est relancée.',
        when: 'une pièce attendue n’est pas reçue sous 7 jours',
        then: 'relancer le client',
        otherwise: 'classer la pièce dans le dossier',
        appliesTo: ['t2'],
        rationale: 'Règle usuelle de relance documentaire.',
      },
    ],
    dataObjects: [],
    indicators: [],
    informationFlows: [],
    rationale: `Enchaînement plausible de « ${data.process.label} » dans un cabinet d’expertise comptable.`,
  };
}

function genericFlow(data: FlowData, actor: string): unknown {
  const label = data.process.label;
  const withControl = APPLICATION_MACROS.has(canon(data.process.macro));
  const created = data.tasks.length === 0;
  const tasks: Obj[] = created
    ? [
        {
          ref: 't1',
          label: `${label} : préparation`,
          description: 'Rassembler les éléments nécessaires.',
        },
        { ref: 't2', label: `${label} : réalisation`, description: 'Réaliser le traitement.' },
      ].map((t) => ({
        ...t,
        container: 'process',
        kind: 'task',
        actor,
        execution: 'manual',
        rationale: `Découpage usuel de « ${label} » en préparation puis réalisation (hypothèse de l’outil).`,
      }))
    : [];
  const refs = created ? tasks.map((t) => t['ref'] as string) : data.tasks.map((t) => t.code);
  const last = refs[refs.length - 1] as string;
  const after = withControl ? 'gw' : 'end';
  const nodes: Obj[] = [
    event('start', 'process', `Début : ${label}`, 'start'),
    ...tasks,
    ...(withControl
      ? [
          {
            ref: 'gw',
            container: 'process',
            kind: 'gateway',
            label: 'Résultat conforme ?',
            gatewayType: 'exclusive',
            rule: 'r1',
            actor,
            rationale:
              'Un contrôle précède la suite dans les processus couverts par l’application.',
          },
        ]
      : []),
    event('end', 'process', `Fin : ${label}`, 'end'),
  ];
  const edges: Obj[] = [{ container: 'process', from: 'start', to: refs[0] as string }];
  refs.forEach((ref, i) => {
    edges.push({ container: 'process', from: ref, to: refs[i + 1] ?? after });
  });
  if (withControl) {
    edges.push({
      container: 'process',
      from: 'gw',
      to: 'end',
      condition: 'Conforme',
      isDefault: true,
    });
    edges.push({ container: 'process', from: 'gw', to: last, condition: 'Non conforme' });
  }
  return {
    nodes,
    edges,
    rules: withControl
      ? [
          {
            ref: 'r1',
            type: 'decision',
            label: `Conformité : ${label}`,
            text: 'Le résultat est contrôlé avant de passer à la suite.',
            when: 'le résultat est conforme',
            then: 'poursuivre',
            otherwise: 'reprendre la dernière tâche',
            appliesTo: [last],
            rationale: 'Contrôle usuel avant livraison au sein du cabinet.',
          },
        ]
      : [],
    dataObjects: [],
    indicators: [],
    informationFlows: [],
    rationale: `Enchaînement plausible de « ${label} » (connaissance générale du secteur).`,
  };
}

// ------------------------------------------------------------------ niveau 3

function relanceDetail(task: TaskInfo, prefix: string, assistant: string): Obj {
  const C = task.code;
  const p = (ref: string): string => `${prefix}${ref}`;
  const step = (ref: string, label: string, extra: Obj = {}): Obj => ({
    ref: p(ref),
    container: C,
    kind: 'step',
    label,
    actor: assistant,
    execution: 'manual',
    rationale: 'Pratique courante de relance des pièces manquantes (hypothèse de l’outil).',
    ...extra,
  });
  const edge = (from: string, to: string, extra: Obj = {}): Obj => ({
    container: C,
    from: p(from),
    to: p(to),
    ...extra,
  });
  return {
    nodes: [
      event(p('start'), C, 'Pièce manquante constatée', 'start'),
      step('s1', 'Préparer la relance', { outputs: [p('d1')] }),
      step('s2', 'Envoyer la relance au client', { inputs: [p('d1')] }),
      event(p('err'), C, 'Adresse de messagerie invalide', 'boundary', {
        trigger: 'error',
        attachedTo: p('s2'),
      }),
      event(p('wait'), C, 'Attendre la réponse du client', 'intermediate', {
        trigger: 'timer',
        timer: 'J+7 après l’envoi',
      }),
      {
        ref: p('g1'),
        container: C,
        kind: 'gateway',
        label: 'Pièces reçues dans le délai ?',
        gatewayType: 'exclusive',
        rule: p('rl1'),
        actor: assistant,
        rationale: 'La suite dépend de la réception des pièces dans le délai.',
      },
      step('s3', 'Relancer par téléphone'),
      step('s4', 'Escalader au chef de mission', { actor: 'Chef de mission' }),
      event(p('end1'), C, 'Pièces reçues', 'end'),
      event(p('end2'), C, 'Dossier escaladé', 'end'),
    ],
    edges: [
      edge('start', 's1'),
      edge('s1', 's2'),
      edge('s2', 'wait'),
      edge('wait', 'g1'),
      edge('g1', 'end1', { condition: 'Pièces reçues dans le délai', isDefault: true }),
      edge('g1', 's3', { condition: 'Aucune réponse après J+7' }),
      edge('err', 's3'),
      edge('s3', 's4'),
      edge('s4', 'end2'),
    ],
    rules: [
      {
        ref: p('rl1'),
        type: 'decision',
        label: 'Pièces reçues dans le délai',
        text: 'Une pièce non reçue sous 7 jours est relancée par téléphone, puis escaladée.',
        when: 'la pièce n’est pas reçue sous 7 jours',
        then: 'relancer par téléphone puis escalader au chef de mission',
        otherwise: 'classer la pièce dans le dossier',
        appliesTo: [C],
        rationale: 'Règle de relance usuelle.',
      },
      {
        ref: p('rl2'),
        type: 'exception',
        label: 'Délai de relance',
        text: 'Les relances suivent un calendrier fixe : J+7, J+14, puis escalade.',
        circuit: 'deadline',
        circuitDescription:
          'Relance à J+7 et J+14 ; escalade au chef de mission après trois relances sans réponse',
        appliesTo: [C],
        rationale: 'Circuit de délais usuel d’une relance documentaire.',
      },
    ],
    dataObjects: [
      {
        ref: p('d1'),
        label: 'Courriel de relance des pièces',
        nature: 'form',
        fields: [
          { name: 'Destinataire', type: 'text', required: true, personalData: true },
          { name: 'Pièces manquantes', type: 'text', required: true },
          { name: 'Date limite de réponse', type: 'date', required: true },
          { name: 'Canal d’envoi', type: 'enum', enumValues: ['Courriel', 'Téléphone'] },
          { name: 'Numéro de la relance', type: 'number' },
        ],
        rationale: 'Champs usuels d’une relance de pièces.',
      },
    ],
    indicators: [
      {
        ref: p('ind1'),
        label: 'Délai de réponse attendu du client',
        target: C,
        measure: 'lead_time',
        exact: 7,
        unit: 'jours',
        period: 'occurrence',
        nature: 'estimated',
        rationale: 'Délai courant laissé au client avant relance.',
      },
      {
        ref: p('ind2'),
        label: 'Relances avant escalade',
        target: C,
        measure: 'frequency',
        exact: 3,
        unit: 'relances',
        period: 'occurrence',
        nature: 'estimated',
        rationale: 'Nombre usuel de relances avant escalade.',
      },
    ],
    informationFlows: [
      {
        label: 'Relance des pièces manquantes',
        from: assistant,
        to: 'Client du cabinet',
        dataObjects: [p('d1')],
        channel: 'email',
        activity: p('s2'),
        frequency: 'tous les 7 jours',
        rationale: 'La relance part de l’assistant vers le client.',
      },
      {
        label: 'Escalade du dossier',
        from: assistant,
        to: 'Chef de mission',
        dataObjects: [p('d1')],
        channel: 'email',
        activity: p('s4'),
        rationale: 'Le chef de mission est informé de l’escalade.',
      },
    ],
  };
}

function genericDetail(task: TaskInfo, prefix: string, actor: string): Obj {
  const C = task.code;
  const p = (ref: string): string => `${prefix}${ref}`;
  const step = (ref: string, label: string): Obj => ({
    ref: p(ref),
    container: C,
    kind: 'step',
    label,
    actor,
    execution: 'manual',
    rationale: `Découpage usuel de « ${task.label} » en trois étapes (hypothèse de l’outil).`,
  });
  return {
    nodes: [
      event(p('start'), C, `Début : ${task.label}`, 'start'),
      step('s1', `${task.label} : préparer`),
      step('s2', `${task.label} : exécuter`),
      step('s3', `${task.label} : vérifier`),
      event(p('end'), C, `Fin : ${task.label}`, 'end'),
    ],
    edges: [
      { container: C, from: p('start'), to: p('s1') },
      { container: C, from: p('s1'), to: p('s2') },
      { container: C, from: p('s2'), to: p('s3') },
      { container: C, from: p('s3'), to: p('end') },
    ],
  };
}

function detailScenario(data: FlowData, actor: string): unknown {
  const merged = {
    ...empty,
    rationale: `Détail des tâches de « ${data.process.label} » (niveau 3).`,
  };
  const parts: Obj[] = data.detailTasks.map((task, i) => {
    const prefix = `d${i + 1}_`;
    const assistant = data.actors.some((a) => a.label === 'Assistant administratif')
      ? 'Assistant administratif'
      : actor;
    return canon(task.label) === canon(PILOT_RELANCE_TASK)
      ? relanceDetail(task, prefix, assistant)
      : genericDetail(task, prefix, task.actor ?? actor);
  });
  const concat = (key: string): unknown[] =>
    parts.flatMap((part) => (part[key] as unknown[]) ?? []);
  return {
    ...merged,
    nodes: concat('nodes'),
    edges: concat('edges'),
    rules: concat('rules'),
    dataObjects: concat('dataObjects'),
    indicators: concat('indicators'),
    informationFlows: concat('informationFlows'),
  };
}

/** `process.flow` : enchaînement du processus (mode `flow`) ou niveau 3 des tâches (mode `detail`). */
export function pilotProcessFlowScenario(req: ScenarioRequest): unknown {
  const data = parse(req);
  if (data === null) return empty;
  const actor = actorFor(data);
  if (data.mode === 'detail') return detailScenario(data, actor);
  if (canon(data.process.label) === canon(PILOT_RELANCE_PROCESS) && data.tasks.length === 0) {
    return relancesFlow(data, actor);
  }
  return genericFlow(data, actor);
}

/** Scénario du pilote par pipeline (à enregistrer auprès du fournisseur factice). */
export const PILOT_FLOW_SCENARIOS: Record<string, (req: ScenarioRequest) => unknown> = {
  'process.flow': pilotProcessFlowScenario,
};
