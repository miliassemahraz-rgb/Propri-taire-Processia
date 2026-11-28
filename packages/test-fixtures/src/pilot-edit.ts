/**
 * Scénario factice de `model.edit` (WP-20, spécification 4.2) : reconnaît par expression régulière
 * les consignes types de la cartographie du pilote, sans appel réel :
 *
 * 1. ajouter une validation (une étape) après ou avant une tâche, avec ou sans responsable ;
 * 2. déplacer une tâche vers un autre acteur ;
 * 3. ajouter une exception (relance, escalade, délai, alerte) à une tâche ;
 * 4. supprimer une étape ;
 * 5. renommer une étape ;
 * 6. changer la valeur d'un indicateur.
 *
 * Une consigne incomplète (« ajoute une validation par le chef de mission ») ou une cible
 * ambiguë produit une question de clarification, jamais une proposition. La sortie respecte le
 * schéma `EditPlan` : le fournisseur factice ne peut pas renvoyer ce que le vrai ne pourrait pas
 * renvoyer.
 */
import type { ScenarioRequest } from './pilot.js';

const DONNEES_RE = /<donnees>\n([\s\S]*?)\n<\/donnees>/;

interface Node {
  code: string;
  label: string;
  actor?: string;
}
interface EditData {
  instruction: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  focus: { diagram: string; selected?: { code: string; label: string } };
  actors: { code: string; label: string }[];
  processes: {
    code: string;
    label: string;
    macro: string;
    tasks: { code: string; label: string; actor?: string }[];
  }[];
  scope?: {
    code: string;
    label: string;
    nodes: { code: string; kind: string; label: string; actor?: string; container: string }[];
    indicators: { code: string; label: string; unit: string }[];
  };
}

type Action = Record<string, unknown>;
interface Plan {
  clarification?: string;
  explanation: string;
  actions: Action[];
  touched: string[];
}

/** Texte comparable : sans accents, minuscules, espaces et apostrophes normalisés. */
const canon = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const ARTICLE = /^(?:le |la |l'|les |un |une |du |de la |de l'|des )/;
const stripArticle = (s: string): string => s.trim().replace(ARTICLE, '').trim();
const unquote = (s: string): string =>
  s
    .trim()
    .replace(/^[«"“]\s*/, '')
    .replace(/\s*[»"”]$/, '')
    .trim();

function clarify(question: string): Plan {
  return {
    clarification: question,
    explanation: 'Aucune modification proposée tant que la consigne n’est pas précisée.',
    actions: [],
    touched: [],
  };
}

const HELP =
  'Je n’ai pas compris cette consigne. Je sais ajouter une étape après ou avant une tâche, ' +
  'confier une tâche à un autre acteur, renommer ou supprimer une étape, ajouter une exception ' +
  'de relance ou changer la valeur d’un indicateur.';

/** Tâches et étapes que la consigne peut viser : le détail du processus affiché, sinon la liste compacte. */
function candidates(data: EditData): Node[] {
  const nodes =
    data.scope?.nodes
      .filter((n) => n.kind === 'task' || n.kind === 'step')
      .map((n) => ({
        code: n.code,
        label: n.label,
        ...(n.actor === undefined ? {} : { actor: n.actor }),
      })) ?? [];
  if (nodes.length > 0) return nodes;
  return data.processes.flatMap((p) => p.tasks);
}

type Found = { ok: true; node: Node } | { ok: false; question: string };

/** Cherche l'élément désigné par `phrase` (libellé complet ou partiel, ou « cette tâche »). */
function findNode(data: EditData, rawPhrase: string, what = 'la tâche'): Found {
  const phrase = canon(stripArticle(unquote(rawPhrase)));
  if (/^(?:cette|cet) (?:tache|etape|element)$/.test(phrase)) {
    const selected = data.focus.selected;
    return selected === undefined
      ? {
          ok: false,
          question: `Quelle tâche voulez-vous dire ? Sélectionnez-la dans la cartographie ou donnez son nom.`,
        }
      : { ok: true, node: { code: selected.code, label: selected.label } };
  }
  if (phrase === '') return { ok: false, question: `Quelle tâche voulez-vous dire ?` };
  const all = candidates(data);
  const exact = all.filter((n) => canon(n.label) === phrase);
  if (exact.length === 1) return { ok: true, node: exact[0] as Node };
  const partial = all.filter((n) => {
    const label = canon(n.label);
    return label.includes(phrase) || phrase.includes(label);
  });
  if (partial.length === 1) return { ok: true, node: partial[0] as Node };
  if (partial.length > 1) {
    return {
      ok: false,
      question: `Plusieurs tâches correspondent à « ${rawPhrase.trim()} » : ${partial
        .slice(0, 4)
        .map((n) => `« ${n.label} » (${n.code})`)
        .join(', ')}. Laquelle ?`,
    };
  }
  // Repli : un processus ou un macroprocessus du même nom désigne sa dernière tâche.
  const owners = data.processes.filter(
    (p) => canon(p.label).includes(phrase) || canon(p.macro).includes(phrase),
  );
  const withTasks = owners.filter((p) => p.tasks.length > 0);
  if (withTasks.length === 1) {
    const tasks = (withTasks[0] as EditData['processes'][number]).tasks;
    return { ok: true, node: tasks[tasks.length - 1] as Node };
  }
  if (withTasks.length > 1) {
    return {
      ok: false,
      question: `« ${rawPhrase.trim()} » correspond à plusieurs processus (${withTasks
        .slice(0, 4)
        .map((p) => `${p.code} ${p.label}`)
        .join(', ')}). Après quelle tâche exactement ?`,
    };
  }
  return {
    ok: false,
    question: `Je ne trouve pas ${what} « ${rawPhrase.trim()} » dans ce niveau. Donnez le nom exact de la tâche, ou ouvrez le niveau du processus concerné.`,
  };
}

function findActor(data: EditData, rawPhrase: string): { label: string } | null {
  const phrase = canon(stripArticle(unquote(rawPhrase)));
  if (phrase === '') return null;
  const exact = data.actors.find((a) => canon(a.label) === phrase);
  if (exact !== undefined) return { label: exact.label };
  const partial = data.actors.filter(
    (a) => canon(a.label).includes(phrase) || phrase.includes(canon(a.label)),
  );
  return partial.length === 1 ? { label: (partial[0] as { label: string }).label } : null;
}

const KIND_WORD: Record<string, string> = {
  validation: 'Validation',
  contrôle: 'Contrôle',
  controle: 'Contrôle',
  vérification: 'Vérification',
  verification: 'Vérification',
  relecture: 'Relecture',
  revue: 'Revue',
  étape: 'Étape',
  etape: 'Étape',
  tâche: 'Tâche',
  tache: 'Tâche',
};

function planInsert(data: EditData, text: string): Plan | null {
  const m =
    /^(?:ajoute|ajouter|insère|insere|insérer|crée|cree|créer)\s+(?:une?\s+|l')?(validation|contrôle|controle|vérification|verification|relecture|revue|étape|etape|tâche|tache)\b\s*(.*)$/i.exec(
      text,
    );
  if (m === null) return null;
  const kind = KIND_WORD[(m[1] as string).toLowerCase()] ?? 'Étape';
  const rest = (m[2] as string).trim();
  const quoted = /[«"“]\s*(.+?)\s*[»"”]/.exec(rest);
  const placement = /\b(après|apres|avant)\s+(.+?)\s*$/i.exec(rest.replace(/[«»"“”]/g, ' '));
  const byMatch = /\bpar\s+(le |la |l'|les |un |une )?(.+?)(?=\s+(?:après|apres|avant)\b|$)/i.exec(
    rest.replace(/[«»"“”]/g, ' '),
  );
  let actor: { label: string } | null = null;
  if (byMatch !== null) {
    actor = findActor(data, `${byMatch[1] ?? ''}${byMatch[2] as string}`);
    if (actor === null) {
      const known = data.actors
        .slice(0, 8)
        .map((a) => a.label)
        .join(', ');
      return clarify(
        `Je ne connais pas l’acteur « ${(byMatch[2] as string).trim()} ». Acteurs connus : ${known}.`,
      );
    }
  }
  if (placement === null) {
    return clarify(
      'À quel endroit faut-il l’ajouter ? Indiquez la tâche qui la précède, par exemple « après la saisie ».',
    );
  }
  const found = findNode(data, placement[2] as string, 'la tâche');
  if (!found.ok) return clarify(found.question);
  const label =
    quoted !== null
      ? (quoted[1] as string)
      : `${kind}${byMatch !== null ? ` par ${byMatch[1] ?? 'le '}${canon(actor?.label ?? '')}` : ''}`;
  const where = canon(placement[1] as string).startsWith('av') ? 'before' : 'after';
  return {
    explanation: `Ajoute la tâche « ${label} » ${where === 'after' ? 'après' : 'avant'} « ${found.node.label} »${
      actor === null ? ' (sans responsable)' : `, confiée à ${actor.label}`
    }.`,
    actions: [
      {
        action: 'insert_task',
        label,
        anchor: found.node.code,
        placement: where,
        ...(actor === null ? {} : { actor: actor.label }),
      },
    ],
    touched: [found.node.code],
  };
}

function planReassign(data: EditData, text: string): Plan | null {
  const m =
    /^(?:déplace|deplace|transfère|transfere|confie|affecte|attribue|passe)\s+(?:la tâche |la tache |l'étape |l'etape |la |le |l')?(.+?)\s+(?:à la |à l'|à |au |aux |vers la |vers l'|vers le |vers |chez la |chez l'|chez le |chez )(.+)$/i.exec(
      text,
    );
  if (m === null) return null;
  const found = findNode(data, m[1] as string);
  if (!found.ok) return clarify(found.question);
  const actor = findActor(data, m[2] as string);
  if (actor === null) {
    return clarify(
      `Je ne connais pas l’acteur « ${unquote(m[2] as string)} ». Quel acteur voulez-vous ?`,
    );
  }
  return {
    explanation: `Confie la tâche « ${found.node.label} » à ${actor.label}.`,
    actions: [{ action: 'reassign', target: found.node.code, actor: actor.label }],
    touched: [found.node.code],
  };
}

const CIRCUITS: Record<
  string,
  { circuit: string; text: string; when: string; then: string; description: string }
> = {
  relance: {
    circuit: 'reminder',
    text: 'Sans réponse sous 7 jours, le client est relancé ; après deux relances sans réponse, le dossier est escaladé.',
    when: 'aucune réponse sous 7 jours',
    then: 'relancer le client',
    description: 'Relance à J+7 ; escalade au chef de mission après deux relances sans réponse',
  },
  escalade: {
    circuit: 'escalation',
    text: 'Sans résolution sous 15 jours, le dossier est remonté au chef de mission.',
    when: 'aucune résolution sous 15 jours',
    then: 'escalader au chef de mission',
    description: 'Escalade au chef de mission après 15 jours sans résolution',
  },
  delai: {
    circuit: 'deadline',
    text: 'Un délai maximal de 10 jours est laissé pour terminer la tâche.',
    when: 'le délai de 10 jours est dépassé',
    then: 'alerter le responsable',
    description: 'Alerte du responsable au dépassement du délai de 10 jours',
  },
  alerte: {
    circuit: 'alert',
    text: 'Une alerte est envoyée au responsable en cas d’anomalie.',
    when: 'une anomalie est constatée',
    then: 'alerter le responsable',
    description: 'Alerte du responsable dès qu’une anomalie est constatée',
  },
};

function planException(data: EditData, text: string): Plan | null {
  const m =
    /^(?:ajoute|ajouter|crée|cree|créer)\s+une?\s+exception(?:\s+(?:de|d'|du)\s*(relance|escalade|délai|delai|alerte))?\s+(?:à la |à l'|à |pour la |pour l'|pour le |pour |sur la |sur l'|sur le |sur |dans la |dans l'|dans le |dans )(.+)$/i.exec(
      text,
    );
  if (m === null) return null;
  const found = findNode(data, m[2] as string);
  if (!found.ok) return clarify(found.question);
  const key = canon(m[1] ?? 'relance');
  const circuit = CIRCUITS[key] ?? (CIRCUITS['relance'] as (typeof CIRCUITS)[string]);
  const name = key === 'delai' ? 'délai' : key;
  return {
    explanation: `Ajoute une exception de ${name} à la tâche « ${found.node.label} » : ${circuit.description}.`,
    actions: [
      {
        action: 'add_exception',
        target: found.node.code,
        label: `Exception de ${name} : ${found.node.label}`,
        text: circuit.text,
        when: circuit.when,
        then: circuit.then,
        circuit: circuit.circuit,
        circuitDescription: circuit.description,
      },
    ],
    touched: [found.node.code],
  };
}

function planRemove(data: EditData, text: string): Plan | null {
  const m =
    /^(?:supprime|supprimer|retire|retirer|enlève|enleve|efface)\s+(?:la tâche |la tache |l'étape |l'etape |la |le |l')?(.+)$/i.exec(
      text,
    );
  if (m === null) return null;
  const found = findNode(data, m[1] as string);
  if (!found.ok) return clarify(found.question);
  return {
    explanation: `Supprime la tâche « ${found.node.label} » et raccorde l’étape précédente à la suivante.`,
    actions: [{ action: 'remove', target: found.node.code }],
    touched: [found.node.code],
  };
}

function planRename(data: EditData, text: string): Plan | null {
  const m =
    /^(?:renomme|renommer|appelle|nomme)\s+(?:la tâche |la tache |l'étape |l'etape |la |le |l')?(.+?)\s+en\s+(.+)$/i.exec(
      text,
    );
  if (m === null) return null;
  const found = findNode(data, m[1] as string);
  if (!found.ok) return clarify(found.question);
  const label = unquote(m[2] as string);
  return {
    explanation: `Renomme « ${found.node.label} » en « ${label} ».`,
    actions: [{ action: 'rename', target: found.node.code, label }],
    touched: [found.node.code],
  };
}

function planIndicator(data: EditData, text: string): Plan | null {
  const m =
    /^(?:change|changer|modifie|modifier|passe|mets|mettre|fixe)\s+(?:l'indicateur\s+|le délai\s+|le delai\s+|la durée\s+|la duree\s+|le volume\s+)?(.+?)\s+(?:à|a|en|sur)\s+(\d+(?:[.,]\d+)?)\s*(.*)$/i.exec(
      text,
    );
  if (m === null) return null;
  const indicators = data.scope?.indicators ?? [];
  const phrase = canon(stripArticle(unquote(m[1] as string)));
  const matching = indicators.filter((i) => {
    const label = canon(i.label);
    return label.includes(phrase) || phrase.includes(label);
  });
  if (matching.length === 0) {
    return clarify(
      indicators.length === 0
        ? 'Je ne trouve aucun indicateur à ce niveau. Ouvrez le niveau du processus ou de la tâche concernée.'
        : `Je ne trouve pas cet indicateur. Indicateurs disponibles : ${indicators
            .slice(0, 5)
            .map((i) => `« ${i.label} »`)
            .join(', ')}.`,
    );
  }
  if (matching.length > 1) {
    return clarify(
      `Plusieurs indicateurs correspondent : ${matching
        .slice(0, 4)
        .map((i) => `« ${i.label} »`)
        .join(', ')}. Lequel ?`,
    );
  }
  const indicator = matching[0] as { code: string; label: string; unit: string };
  const value = Number((m[2] as string).replace(',', '.'));
  const unit = unquote((m[3] as string).replace(/[.]$/, '')) || indicator.unit;
  return {
    explanation: `Fixe l’indicateur « ${indicator.label} » à ${value} ${unit}.`,
    actions: [{ action: 'set_indicator', target: indicator.code, exact: value, unit }],
    touched: [indicator.code],
  };
}

/** Une consigne peut compléter la précédente (réponse à une question de clarification). */
function plansFor(data: EditData, text: string): Plan | null {
  const clean = text.trim().replace(/[.!]+$/, '');
  return (
    planInsert(data, clean) ??
    planReassign(data, clean) ??
    planException(data, clean) ??
    planRename(data, clean) ??
    planRemove(data, clean) ??
    planIndicator(data, clean)
  );
}

export function pilotModelEditScenario(req: ScenarioRequest): unknown {
  const content = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const m = DONNEES_RE.exec(content);
  if (m === null) return clarify(HELP);
  const data = JSON.parse(m[1] as string) as EditData;
  const alone = plansFor(data, data.instruction);
  const previous = [...data.history].reverse().find((h) => h.role === 'user');
  // Une réponse à une question de clarification s'ajoute à la consigne d'origine.
  if (previous !== undefined) {
    const lastQuestion = [...data.history].reverse().find((h) => h.role === 'assistant');
    const answering = lastQuestion !== undefined && data.history.at(-1)?.role === 'assistant';
    if (answering && (alone === null || alone.clarification !== undefined)) {
      const merged = plansFor(
        data,
        `${previous.content.trim().replace(/[.!]+$/, '')} ${data.instruction}`,
      );
      if (merged !== null) return merged;
    }
  }
  return alone ?? clarify(HELP);
}

/** Scénarios factices du pilote pour la modification par dialogue, par nom de pipeline. */
export const PILOT_EDIT_SCENARIOS: Record<string, (req: ScenarioRequest) => unknown> = {
  'model.edit': pilotModelEditScenario,
};
