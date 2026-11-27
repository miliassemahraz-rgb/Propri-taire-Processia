/**
 * Scénarios factices du pilote pour le questionnement guidé et les hypothèses (WP-14) : sorties
 * scriptées de `questions`, `answer.integrate`, `hypotheses` et `deliverable.summary`. Comme pour
 * l'extraction (WP-12), les citations sont des sous-chaînes exactes des réponses qu'elles citent.
 */
import type { ScenarioRequest } from './pilot.js';

const canon = (s: string): string =>
  s.normalize('NFC').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();

const DONNEES_RE = /<donnees>\n([\s\S]*?)\n<\/donnees>/;

function donnees<T>(req: ScenarioRequest): T | null {
  const content = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const m = DONNEES_RE.exec(content);
  return m === null ? null : (JSON.parse(m[1] as string) as T);
}

// ------------------------------------------------------------------ questions

interface QuestionsData {
  report: {
    concept: string;
    gaps: { check: string; message: string; elementCode?: string; elementLabel?: string }[];
  }[];
  asked: string[];
}

interface ScriptedQuestion {
  text: string;
  concept: string;
  targetCodes: string[];
  blockingScore: number;
  rationale: string;
}

/** Macroprocessus couverts par l'application (CDC 8.2) : leurs manques bloquent davantage. */
const APPLICATION_MACROS = new Set(
  ['P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11'].map(canon),
);

export const PILOT_QUESTION_ENVIRONMENT =
  'Dans quel environnement (réglementaire, concurrentiel, technique) le cabinet exerce-t-il son métier ?';

/**
 * `questions` : une question par manque connu du rapport de complétude. La question sur
 * l'environnement du métier bloque le plus ; les tâches de la production comptable (P05)
 * passent avant les autres processus, et les macroprocessus seulement cartographiés après.
 */
export function pilotQuestionsScenario(req: ScenarioRequest): unknown {
  const data = donnees<QuestionsData>(req);
  if (data === null) return { questions: [] };
  const asked = new Set(data.asked.map(canon));
  const found: ScriptedQuestion[] = [];
  const add = (q: ScriptedQuestion): void => {
    if (!asked.has(canon(q.text)) && !found.some((x) => canon(x.text) === canon(q.text))) {
      found.push(q);
    }
  };
  for (const concept of data.report) {
    for (const gap of concept.gaps) {
      switch (gap.check) {
        case 'business.environment':
          add({
            text: PILOT_QUESTION_ENVIRONMENT,
            concept: 'business',
            targetCodes: [],
            blockingScore: 92,
            rationale: "L'environnement du métier n'est pas renseigné : il conditionne les règles.",
          });
          break;
        case 'business.summary':
          add({
            text: 'Pouvez-vous résumer le métier du cabinet en quelques phrases ?',
            concept: 'business',
            targetCodes: [],
            blockingScore: 58,
            rationale: 'La fiche métier ne comporte pas encore de synthèse.',
          });
          break;
        case 'activities.process_has_task': {
          if (gap.elementCode === undefined || gap.elementLabel === undefined) break;
          const macro = canon(gap.elementCode.split('.')[0] ?? '');
          const index = Number(gap.elementCode.split('.')[1] ?? '1');
          const score =
            macro === 'p05'
              ? 90 - 2 * index
              : APPLICATION_MACROS.has(macro)
                ? 60 - index
                : 30 - index;
          add({
            text: `Quelles sont les tâches du processus « ${gap.elementLabel} » ?`,
            concept: 'activities',
            targetCodes: [gap.elementCode],
            blockingScore: Math.max(score, 1),
            rationale: `Le processus « ${gap.elementLabel} » n'a aucune tâche : impossible de décrire qui fait quoi.`,
          });
          break;
        }
        case 'rules.any':
          add({
            text: 'Quelles règles de décision encadrent le traitement d’un dossier client ?',
            concept: 'rules',
            targetCodes: [],
            blockingScore: 66,
            rationale: 'Aucune règle de gestion n’est connue.',
          });
          break;
        case 'indicators.any':
          add({
            text: 'Quels volumes et délais suivez-vous pour vos processus ?',
            concept: 'indicators',
            targetCodes: [],
            blockingScore: 62,
            rationale: 'Aucun indicateur n’est connu : les gains ne pourront pas être chiffrés.',
          });
          break;
        default:
          break;
      }
    }
  }
  const ranked = found
    .map((q, i) => ({ q, i }))
    .sort((a, b) => b.q.blockingScore - a.q.blockingScore || a.i - b.i)
    .slice(0, 12)
    .map((x) => x.q);
  return { questions: ranked };
}

// ------------------------------------------------------------------ answer.integrate

export const PILOT_ANSWER_ENVIRONMENT =
  "Le cabinet travaille dans un environnement très réglementé : plan comptable général, obligations déclaratives fiscales et sociales à échéances fixes, contrôle de l'Ordre des experts-comptables.";

export const PILOT_ANSWER_SAISIE =
  'La saisie comprend la réception des pièces, la saisie des écritures et le contrôle de cohérence. Ces tâches sont réalisées par le collaborateur comptable.';

export const PILOT_ANSWER_IMPUTATION =
  "L'imputation comprend le choix du compte et la ventilation analytique. Ces tâches sont réalisées par le collaborateur comptable.";

interface AnswerEntry {
  quote: string;
  candidate: Record<string, unknown>;
}

const task = (parent: string, label: string, quote: string): AnswerEntry => ({
  quote,
  candidate: {
    kind: 'activity',
    label,
    activity: { level: 'task', parent, responsible: 'Collaborateur comptable' },
  },
});

const ANSWER_ENTRIES: AnswerEntry[] = [
  {
    quote: PILOT_ANSWER_ENVIRONMENT,
    candidate: {
      kind: 'business_trait',
      label: 'Environnement réglementaire',
      trait: {
        facet: 'environment',
        text: "Environnement très réglementé : plan comptable général, obligations déclaratives fiscales et sociales à échéances fixes, contrôle de l'Ordre des experts-comptables",
      },
    },
  },
  task('Saisie', 'Réception des pièces', 'la réception des pièces'),
  task('Saisie', 'Saisie des écritures', 'la saisie des écritures'),
  task('Saisie', 'Contrôle de cohérence', 'le contrôle de cohérence'),
  task('Imputation', 'Choix du compte', 'le choix du compte'),
  task('Imputation', 'Ventilation analytique', 'la ventilation analytique'),
];

const CHUNK_RE = /<morceau id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/morceau>/;

/** `answer.integrate` : les candidats dont la citation figure dans la réponse du consultant. */
export function pilotAnswerIntegrateScenario(req: ScenarioRequest): unknown {
  const content = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const m = CHUNK_RE.exec(content);
  if (m === null) return { candidates: [] };
  const [, chunkId, text] = m as unknown as [string, string, string];
  const haystack = canon(text);
  const found = ANSWER_ENTRIES.filter((e) => haystack.includes(canon(e.quote)));
  return {
    candidates: found.map((e, i) => ({ ref: `c${i + 1}`, chunkId, quote: e.quote, ...e.candidate })),
  };
}

// ------------------------------------------------------------------ hypotheses

interface HypothesesData {
  rejected: { kind: string; label: string }[];
}

/** Les hypothèses du pilote : connaissance générale du métier de l'expertise comptable. */
export const PILOT_HYPOTHESES: {
  rationale: string;
  proposal: { kind: string; label: string } & Record<string, unknown>;
}[] = [
  {
    rationale:
      'La liasse fiscale est le document de synthèse habituel des déclarations de résultat d’un cabinet comptable.',
    proposal: {
      kind: 'glossary_term',
      label: 'Liasse fiscale',
      term: {
        definition:
          'Ensemble des formulaires déposés chaque année auprès de l’administration fiscale pour déclarer le résultat de l’entreprise.',
        synonyms: [],
      },
    },
  },
  {
    rationale: 'Les cabinets conservent habituellement les pièces clients dans une GED.',
    proposal: { kind: 'tool', label: 'Logiciel de GED', tool: { nature: 'software' } },
  },
  {
    rationale:
      'L’activité d’un cabinet comptable culmine autour de la clôture annuelle et des échéances fiscales.',
    proposal: {
      kind: 'business_trait',
      label: 'Saisonnalité de l’activité',
      trait: {
        facet: 'specificity',
        text: 'Pic d’activité autour de la clôture annuelle et des échéances fiscales',
      },
    },
  },
  {
    rationale:
      'Le commissaire aux comptes intervient fréquemment auprès des clients d’un cabinet comptable.',
    proposal: {
      kind: 'actor',
      label: 'Commissaire aux comptes',
      actor: {
        category: 'external',
        responsibilities: ['Certification des comptes'],
      },
    },
  },
  {
    rationale: 'La révision comprend habituellement un contrôle de la balance.',
    proposal: {
      kind: 'activity',
      label: 'Contrôle de la balance',
      activity: { level: 'task', parent: 'Contrôle des écritures' },
    },
  },
];

/** `hypotheses` : les hypothèses du pilote, sans celles que le consultant a déjà rejetées. */
export function pilotHypothesesScenario(req: ScenarioRequest): unknown {
  const data = donnees<HypothesesData>(req);
  const rejected = new Set((data?.rejected ?? []).map((r) => `${r.kind}|${canon(r.label)}`));
  const kept = PILOT_HYPOTHESES.filter(
    (h) => !rejected.has(`${h.proposal.kind}|${canon(h.proposal.label)}`),
  );
  return {
    proposals: kept.map((h, i) => ({ ref: `h${i + 1}`, rationale: h.rationale, ...h.proposal })),
  };
}

// ------------------------------------------------------------------ deliverable.summary

interface SummaryData {
  traits: { facet: string; label: string; text: string }[];
}

/** `deliverable.summary` : assemble les caractéristiques confirmées en un court paragraphe. */
export function pilotSummaryScenario(req: ScenarioRequest): unknown {
  const data = donnees<SummaryData>(req);
  const traits = data?.traits ?? [];
  const text = traits.map((t) => t.text.replace(/[.\s]+$/, '')).join('. ');
  return {
    text: `Synthèse du métier : ${text || 'aucune caractéristique confirmée'}.`,
    rationale: `Rédigée à partir de ${traits.length} caractéristique(s) du métier.`,
  };
}

/** Scénarios du questionnement guidé par pipeline, à enregistrer auprès du fournisseur factice. */
export const PILOT_GUIDED_SCENARIOS: Record<string, (req: ScenarioRequest) => unknown> = {
  questions: pilotQuestionsScenario,
  'answer.integrate': pilotAnswerIntegrateScenario,
  hypotheses: pilotHypothesesScenario,
  'deliverable.summary': pilotSummaryScenario,
};
