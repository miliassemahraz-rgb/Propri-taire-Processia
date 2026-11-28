import {
  FINDING_FAMILY_OF,
  type Activity,
  type Actor,
  type BusinessModel,
  type Element,
  type FindingType,
  type Gateway,
  type SequenceFlow,
} from '@processia/model';
import type { DetectorId, FindingCandidate } from './types.js';

/**
 * Détecteurs déterministes du diagnostic (spécification 4.4). Fonctions pures : le même modèle
 * donne les mêmes constats, dans le même ordre (code puis identifiant). Ils lisent le modèle qu'on
 * leur donne sans l'interroger sur le statut : l'appelant passe la vue des livrables (AS-IS
 * confirmé ou validé, sans hypothèse).
 */

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byCode = <T extends { code: string; id: string }>(list: T[]): T[] =>
  [...list].sort(
    (a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }) || compare(a.id, b.id),
  );

const all = (model: BusinessModel): Element[] => Object.values(model.elements);
const activities = (model: BusinessModel): Activity[] =>
  byCode(all(model).filter((e): e is Activity => e.kind === 'activity'));
const sequenceFlows = (model: BusinessModel): SequenceFlow[] =>
  byCode(all(model).filter((e): e is SequenceFlow => e.kind === 'sequence_flow'));

const label = (el: { code: string; label: string }): string => `${el.code} « ${el.label} »`;

function candidate(
  detectorId: DetectorId,
  type: FindingType,
  location: string[],
  severity: 1 | 2 | 3,
  title: string,
  evidence: string,
): FindingCandidate {
  return {
    type,
    family: FINDING_FAMILY_OF[type],
    location: [...new Set(location)],
    severity,
    label: title,
    evidence,
    detection: { by: 'rule', detectorId },
  };
}

/** Responsables d'une activité : le responsable désigné et les acteurs `R` du RACI. */
function responsibles(a: Activity): Set<string> {
  const ids = new Set<string>();
  if (a.responsibleActorId !== undefined) ids.add(a.responsibleActorId);
  for (const entry of a.raci) if (entry.role === 'R') ids.add(entry.actorId);
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Tâche sans responsable
// ---------------------------------------------------------------------------------------------

/** `task_without_owner` : une tâche ou une étape sans responsable (ni `responsibleActorId`, ni `R`). */
export function detectTaskWithoutOwner(model: BusinessModel): FindingCandidate[] {
  return activities(model)
    .filter((a) => (a.level === 'task' || a.level === 'step') && responsibles(a).size === 0)
    .map((a) =>
      candidate(
        'task_without_owner',
        'task_without_owner',
        [a.id],
        2,
        `Aucun responsable pour ${label(a)}`,
        `La ${a.level === 'task' ? 'tâche' : 'étape'} ${label(a)} n'a ni responsable désigné ni acteur « R » dans le RACI : personne n'est chargé de la réaliser.`,
      ),
    );
}

// ---------------------------------------------------------------------------------------------
// Transfert par papier ou par courriel
// ---------------------------------------------------------------------------------------------

/**
 * `paper_or_email_transfer` : un flux d'information dont le canal est `paper` ou `email`. La
 * localisation est l'activité qui émet le flux (visible sur la carte), puis le flux lui-même.
 */
export function detectPaperOrEmailTransfer(model: BusinessModel): FindingCandidate[] {
  return byCode(all(model).flatMap((e) => (e.kind === 'information_flow' ? [e] : [])))
    .filter((f) => f.channel === 'paper' || f.channel === 'email')
    .map((f) => {
      const actor = (id: string): string => model.elements[id]?.label ?? id;
      const paper = f.channel === 'paper';
      return candidate(
        'paper_or_email_transfer',
        'paper_or_email_transfer',
        [...(f.activityId === undefined ? [] : [f.activityId]), f.id],
        paper ? 3 : 2,
        `Transfert par ${paper ? 'papier' : 'courriel'} : ${f.label}`,
        `Le flux ${label(f)} de « ${actor(f.fromActorId)} » vers « ${actor(f.toActorId)} » passe par ${paper ? 'le papier' : 'le courriel'} : sans suivi, avec des risques de perte, de ressaisie et de délai.`,
      );
    });
}

// ---------------------------------------------------------------------------------------------
// Ressaisie
// ---------------------------------------------------------------------------------------------

/**
 * `rekeying` : le même objet de données est saisi en entrée par au moins deux activités manuelles
 * d'acteurs différents, sans outil commun. Un constat par objet de données ; la localisation est
 * formée des activités concernées et de l'objet.
 */
export function detectRekeying(model: BusinessModel): FindingCandidate[] {
  const dataObjects = byCode(all(model).flatMap((e) => (e.kind === 'data_object' ? [e] : [])));
  const typists = activities(model).filter(
    (a) => (a.level === 'task' || a.level === 'step') && a.execution !== 'automatic',
  );
  const out: FindingCandidate[] = [];
  for (const data of dataObjects) {
    const users = typists.filter((a) => a.inputs.includes(data.id) && responsibles(a).size > 0);
    const involved = new Set<string>();
    for (let i = 0; i < users.length; i += 1) {
      for (let j = i + 1; j < users.length; j += 1) {
        const [a, b] = [users[i] as Activity, users[j] as Activity];
        const rb = responsibles(b);
        const sameActor = [...responsibles(a)].some((id) => rb.has(id));
        const sharedTool = a.toolIds.some((id) => b.toolIds.includes(id));
        if (!sameActor && !sharedTool) {
          involved.add(a.id);
          involved.add(b.id);
        }
      }
    }
    if (involved.size === 0) continue;
    const typing = users.filter((a) => involved.has(a.id));
    const fields = data.fields.slice(0, 4).map((f) => f.name);
    out.push(
      candidate(
        'rekeying',
        'rekeying',
        [...typing.map((a) => a.id), data.id],
        2,
        `Ressaisie de « ${data.label} »`,
        `« ${data.label} »${fields.length === 0 ? '' : ` (${fields.join(', ')})`} est saisi par ${typing.map(label).join(' et ')}, des acteurs différents qui n'ont aucun outil en commun : la même information est ressaisie.`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dépendance à une seule personne
// ---------------------------------------------------------------------------------------------

/** Nombre minimal de tâches pour parler d'une chaîne critique (règle simple, ADR 0028). */
export const CRITICAL_CHAIN_MIN_TASKS = 3;

/**
 * `single_person_dependency` : un processus d'au moins trois tâches dont un seul acteur interne
 * est responsable de chacune, sans qu'aucun autre acteur n'apparaisse comme consulté (« C ») dans
 * leur RACI (pas de suppléant). Règle simple de la spécification 4.4.
 */
export function detectSinglePersonDependency(model: BusinessModel): FindingCandidate[] {
  const acts = activities(model);
  const out: FindingCandidate[] = [];
  for (const process of acts.filter((a) => a.level === 'process')) {
    const tasks = acts.filter((a) => a.level === 'task' && a.parentId === process.id);
    if (tasks.length < CRITICAL_CHAIN_MIN_TASKS) continue;
    const owners = new Set<string>();
    let deputy = false;
    for (const task of tasks) {
      for (const id of responsibles(task)) owners.add(id);
      if (task.raci.some((r) => r.role === 'C')) deputy = true;
    }
    if (owners.size !== 1 || deputy) continue;
    const owner: Element | undefined = model.elements[[...owners][0] as string];
    if (owner?.kind !== 'actor' || (owner as Actor).category !== 'internal') continue;
    // Une tâche sans responsable ne prouve pas la dépendance : elle relève d'un autre constat.
    if (tasks.some((t) => responsibles(t).size === 0)) continue;
    out.push(
      candidate(
        'single_person_dependency',
        'single_person_dependency',
        [process.id, ...tasks.map((t) => t.id)],
        2,
        `Dépendance à « ${owner.label} » pour ${label(process)}`,
        `« ${owner.label} » est seul responsable des ${tasks.length} tâches de ${label(process)} et aucun suppléant n'est désigné : en son absence, la chaîne s'arrête.`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Boucle de validation inutile
// ---------------------------------------------------------------------------------------------

/** Nombre d'activités d'une boucle au-delà duquel elle est jugée trop longue (« plus de deux niveaux »). */
export const LOOP_MAX_LEVELS = 2;

/** Composantes fortement connexes (Tarjan itératif, ordre déterministe). */
function components(nodes: string[], next: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { id: string; i: number }[] = [{ id: root, i: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1] as { id: string; i: number };
      const { id } = frame;
      if (frame.i === 0 && !index.has(id)) {
        index.set(id, counter);
        low.set(id, counter);
        counter += 1;
        stack.push(id);
        onStack.add(id);
      }
      const successors = next.get(id) ?? [];
      if (frame.i < successors.length) {
        const to = successors[frame.i] as string;
        frame.i += 1;
        if (!index.has(to)) work.push({ id: to, i: 0 });
        else if (onStack.has(to))
          low.set(id, Math.min(low.get(id) as number, index.get(to) as number));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(id) as number));
      }
      if (low.get(id) === index.get(id)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
        } while (member !== id);
        out.push(component);
      }
    }
  }
  return out;
}

/**
 * `useless_validation_loop` : dans l'enchaînement d'un processus ou d'une tâche, une boucle (cycle
 * de flux de séquence) qui traverse une passerelle de décision et plus de deux activités : le
 * travail revient en arrière de plus de deux niveaux de révision.
 */
export function detectUselessValidationLoop(model: BusinessModel): FindingCandidate[] {
  const byContainer = new Map<string, SequenceFlow[]>();
  for (const f of sequenceFlows(model)) {
    byContainer.set(f.containerId, [...(byContainer.get(f.containerId) ?? []), f]);
  }
  const out: FindingCandidate[] = [];
  for (const [container, list] of [...byContainer].sort((a, b) => compare(a[0], b[0]))) {
    const next = new Map<string, string[]>();
    const nodes = new Set<string>();
    for (const f of list) {
      next.set(f.fromId, [...(next.get(f.fromId) ?? []), f.toId]);
      nodes.add(f.fromId);
      nodes.add(f.toId);
    }
    for (const component of components([...nodes].sort(), next)) {
      const first = component[0] as string;
      const loops = component.length > 1 || (next.get(first) ?? []).includes(first);
      if (!loops) continue;
      const members = component
        .map((id) => model.elements[id])
        .filter((e): e is Element => e !== undefined);
      const gateways = byCode(members.filter((e): e is Gateway => e.kind === 'gateway'));
      const steps = byCode(members.filter((e): e is Activity => e.kind === 'activity'));
      if (gateways.length === 0 || steps.length <= LOOP_MAX_LEVELS) continue;
      const owner = model.elements[container];
      const where = owner === undefined ? 'cet enchaînement' : label(owner);
      out.push(
        candidate(
          'useless_validation_loop',
          'useless_validation_loop',
          [...steps.map((s) => s.id), ...gateways.map((g) => g.id)],
          2,
          `Boucle de validation sur ${steps.length} niveaux dans ${where}`,
          `Dans ${where}, une décision renvoie le travail en arrière à travers ${steps.length} activités (${steps.map(label).join(', ')}) : plus de ${LOOP_MAX_LEVELS} niveaux de révision et de retour.`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Décision sans trace
// ---------------------------------------------------------------------------------------------

/**
 * `missing_traceability` : une passerelle de décision (exclusive ou inclusive, avec plusieurs
 * branches) qu'aucune activité en amont, dans le même enchaînement, ne documente par une sortie
 * (objet de données produit). La localisation est la passerelle et les activités qui la précèdent
 * directement (en ne traversant que des événements).
 */
export function detectMissingTraceability(model: BusinessModel): FindingCandidate[] {
  const incoming = new Map<string, SequenceFlow[]>();
  const outgoing = new Map<string, number>();
  for (const f of sequenceFlows(model)) {
    incoming.set(f.toId, [...(incoming.get(f.toId) ?? []), f]);
    outgoing.set(f.fromId, (outgoing.get(f.fromId) ?? 0) + 1);
  }
  const decisions = byCode(all(model).filter((e): e is Gateway => e.kind === 'gateway')).filter(
    (g) => g.type !== 'parallel' && (outgoing.get(g.id) ?? 0) >= 2,
  );
  const out: FindingCandidate[] = [];
  for (const gateway of decisions) {
    const upstream = new Set<string>();
    const direct = new Set<string>();
    const seen = new Set<string>([gateway.id]);
    const queue: { id: string; direct: boolean }[] = [{ id: gateway.id, direct: true }];
    while (queue.length > 0) {
      const current = queue.shift() as { id: string; direct: boolean };
      for (const f of incoming.get(current.id) ?? []) {
        if (seen.has(f.fromId)) continue;
        seen.add(f.fromId);
        const from = model.elements[f.fromId];
        if (from?.kind === 'activity') {
          upstream.add(from.id);
          if (current.direct) direct.add(from.id);
        }
        queue.push({ id: f.fromId, direct: current.direct && from?.kind !== 'activity' });
      }
    }
    const documented = [...upstream].some((id) => {
      const a = model.elements[id];
      return a?.kind === 'activity' && a.outputs.length > 0;
    });
    if (documented) continue;
    out.push(
      candidate(
        'missing_traceability',
        'missing_traceability',
        [gateway.id, ...[...direct].sort()],
        1,
        `Décision sans trace : ${label(gateway)}`,
        `La décision ${label(gateway)} n'est documentée par aucun objet de données produit en amont : son résultat n'est pas tracé (qui a décidé, sur quelle base).`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

export const DETECTORS: Record<DetectorId, (model: BusinessModel) => FindingCandidate[]> = {
  task_without_owner: detectTaskWithoutOwner,
  paper_or_email_transfer: detectPaperOrEmailTransfer,
  rekeying: detectRekeying,
  single_person_dependency: detectSinglePersonDependency,
  useless_validation_loop: detectUselessValidationLoop,
  missing_traceability: detectMissingTraceability,
};

/** Clé d'unicité d'un constat : le type et l'ensemble (trié) des éléments localisés. */
export function findingKey(f: { type: string; location: readonly string[] }): string {
  return `${f.type}|${[...f.location].sort().join(',')}`;
}

/** Tous les détecteurs, dans l'ordre de `DETECTOR_IDS` ; un constat par type et localisation. */
export function runDetectors(model: BusinessModel): FindingCandidate[] {
  const seen = new Set<string>();
  const out: FindingCandidate[] = [];
  for (const id of Object.keys(DETECTORS) as DetectorId[]) {
    for (const found of DETECTORS[id](model)) {
      const key = findingKey(found);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(found);
    }
  }
  return out;
}
