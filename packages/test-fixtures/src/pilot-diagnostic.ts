/**
 * Scénario factice du pilote pour `diagnostic` (WP-21) : des constats plausibles pour le cabinet
 * d'expertise comptable du CDC 8, répartis sur les quatre familles (gaspillages, flux et délais,
 * organisation, risques et conformité). Chaque constat désigne des codes de l'entrée : le
 * scénario lit les activités reçues et ne localise que sur elles (contrôle sémantique du pipeline).
 */
import { PILOT_RELANCE_TASK } from './pilot-flow.js';
import type { ScenarioRequest } from './pilot.js';

const canon = (s: string): string =>
  s.normalize('NFC').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();

const DONNEES_RE = /<donnees>\n([\s\S]*?)\n<\/donnees>/;

interface Activity {
  code: string;
  label: string;
  level: string;
  parent: string;
  actor?: string;
}
interface DiagnosticData {
  macro: { code: string; label: string };
  activities: Activity[];
  decisions: { code: string; label: string }[];
  known: { type: string; locations: string[] }[];
}

interface Finding {
  type: string;
  location: string[];
  severity: 1 | 2 | 3;
  label: string;
  evidence: string;
}

const parse = (req: ScenarioRequest): DiagnosticData | null => {
  const content = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const m = DONNEES_RE.exec(content);
  return m === null ? null : (JSON.parse(m[1] as string) as DiagnosticData);
};

const tasks = (data: DiagnosticData): Activity[] =>
  data.activities.filter((a) => a.level === 'task');

/** Constats propres à chaque macroprocessus du pilote : de quoi couvrir les quatre familles. */
const PER_MACRO: Record<string, (data: DiagnosticData) => Finding[]> = {
  'collecte documentaire': (data) => {
    const relance =
      tasks(data).find((t) => canon(t.label) === canon(PILOT_RELANCE_TASK)) ?? tasks(data)[0];
    if (relance === undefined) return [];
    return [
      {
        type: 'waiting_time',
        location: [relance.code],
        severity: 3,
        label: 'Délai d’attente des pièces du client',
        evidence: `Après « ${relance.label} », le dossier attend la réponse du client sans échéance suivie : le délai de collecte s’allonge de relance en relance.`,
      },
      {
        type: 'repetitive_task',
        location: [relance.code],
        severity: 2,
        label: 'Relances répétées à la main',
        evidence: `« ${relance.label} » est refaite à chaque dossier avec les mêmes gestes (préparer, envoyer, relancer) : une tâche répétitive qui se prête à une règle de relance.`,
      },
    ];
  },
  'production comptable': (data) => {
    const [first, second] = tasks(data);
    if (first === undefined) return [];
    const found: Finding[] = [
      {
        type: 'missing_control',
        location: [first.code],
        severity: 2,
        label: 'Saisie sans contrôle de cohérence',
        evidence: `Rien dans l’enchaînement ne contrôle « ${first.label} » avant la suite : une erreur de saisie se découvre tard, à la révision.`,
      },
    ];
    if (second !== undefined) {
      found.push({
        type: 'duplicate',
        location: [first.code, second.code],
        severity: 2,
        label: 'Préparation et réalisation en double',
        evidence: `« ${first.label} » et « ${second.label} » manipulent les mêmes pièces : le travail de préparation est en partie refait à l’étape suivante.`,
      });
    }
    return found;
  },
  'révision comptable': (data) => {
    const first = tasks(data)[0];
    if (first === undefined) return [];
    return [
      {
        type: 'incompatible_roles',
        location: [first.code],
        severity: 3,
        label: 'Préparer et réviser par la même personne',
        evidence: `« ${first.label} » est confiée à un acteur qui a aussi réalisé le travail révisé : la séparation des rôles attendue d’une révision n’est pas assurée.`,
      },
    ];
  },
  'validation et supervision': (data) => {
    const first = tasks(data)[0];
    if (first === undefined) return [];
    return [
      {
        type: 'bottleneck',
        location: [first.code],
        severity: 2,
        label: 'Goulet d’étranglement chez l’expert-comptable',
        evidence: `Tous les dossiers passent par « ${first.label} » : le travail s’accumule quand l’expert-comptable est indisponible.`,
      },
    ];
  },
  'archivage et conformité': (data) => {
    const first = tasks(data)[0];
    if (first === undefined) return [];
    return [
      {
        type: 'uncovered_obligation',
        location: [first.code],
        severity: 3,
        label: 'Durée de conservation non suivie',
        evidence: `Rien ne vérifie la durée légale de conservation dans « ${first.label} » : l’obligation d’archivage n’est pas couverte par un contrôle.`,
      },
    ];
  },
};

/** `diagnostic` : constats scriptés du macroprocessus reçu (liste vide pour les autres). */
export function pilotDiagnosticScenario(req: ScenarioRequest): unknown {
  const data = parse(req);
  if (data === null) return { findings: [], rationale: 'Aucun macroprocessus à diagnostiquer.' };
  const build = PER_MACRO[canon(data.macro.label)];
  const known = new Set(data.known.map((k) => `${k.type}|${[...k.locations].sort().join(',')}`));
  const findings = (build?.(data) ?? []).filter(
    (f) => !known.has(`${f.type}|${[...f.location].sort().join(',')}`),
  );
  return {
    findings,
    rationale: `Diagnostic de « ${data.macro.label} » à partir de l’AS-IS validé et de l’usage du secteur (hypothèses de l’outil).`,
  };
}

/** Scénario du pilote par pipeline (à enregistrer auprès du fournisseur factice). */
export const PILOT_DIAGNOSTIC_SCENARIOS: Record<string, (req: ScenarioRequest) => unknown> = {
  diagnostic: pilotDiagnosticScenario,
};
