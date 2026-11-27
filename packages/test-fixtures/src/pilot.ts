/**
 * Scénario factice du pilote (WP-12) : le cabinet d'expertise comptable du CDC 8 (8.1 à 8.5)
 * sous la forme d'une description de consultant, un second document contradictoire, et les
 * sorties scriptées des pipelines d'extraction. Le texte et les citations sortent des mêmes
 * données : toute citation scriptée est une sous-chaîne exacte du texte qu'elle cite.
 */

export type PilotScope = 'mapping_only' | 'application';

export interface PilotActivity {
  label: string;
  /** Article et libellé tels qu'écrits dans le texte (la citation en est la partie libellé). */
  article: string;
  /** Citation propre à l'activité (par défaut : article et libellé en minuscules). */
  quote?: string;
  responsible?: string;
}

export interface PilotMacro {
  code: string;
  label: string;
  scope: PilotScope;
  activities: PilotActivity[];
  /** Phrase supplémentaire de la description (hors extraction). */
  note?: string;
}

const a = (article: string, label: string, extra: Partial<PilotActivity> = {}): PilotActivity => ({
  label,
  article,
  ...extra,
});

/** Les 14 macroprocessus du CDC 8.2, avec leurs principales activités et leur couverture. */
export const PILOT_MACROS: PilotMacro[] = [
  {
    code: 'P01',
    label: 'Prospection commerciale',
    scope: 'mapping_only',
    activities: [
      a("l'", 'Identification des prospects'),
      a('la ', 'Qualification des besoins'),
      a('les ', 'Propositions commerciales'),
    ],
  },
  {
    code: 'P02',
    label: 'Entrée en relation client',
    scope: 'mapping_only',
    activities: [
      a('la ', 'Collecte des informations'),
      a('la ', 'Vérification de conformité'),
      a('la ', 'Lettre de mission'),
    ],
  },
  {
    code: 'P03',
    label: 'Gestion du portefeuille clients',
    scope: 'application',
    activities: [
      a('la ', 'Création des dossiers'),
      a("l'", 'Affectation des collaborateurs'),
      a('la ', 'Planification des missions'),
    ],
  },
  {
    code: 'P04',
    label: 'Collecte documentaire',
    scope: 'application',
    activities: [
      a('la ', 'Récupération des factures, relevés bancaires et justificatifs'),
      a('les ', 'Relances clients', {
        quote: "Les relances clients sont assurées par l'assistant administratif",
        responsible: 'Assistant administratif',
      }),
    ],
  },
  {
    code: 'P05',
    label: 'Production comptable',
    scope: 'application',
    activities: [
      a('la ', 'Saisie'),
      a("l'", 'Imputation'),
      a('le ', 'Rapprochement bancaire'),
      a('le ', 'Lettrage'),
    ],
    note: 'Pour ce processus, le suivi est dans l’application ; la saisie reste dans le logiciel comptable.',
  },
  {
    code: 'P06',
    label: 'Révision comptable',
    scope: 'application',
    activities: [
      a('le ', 'Contrôle des écritures'),
      a('le ', 'Traitement des anomalies'),
      a('la ', 'Régularisation'),
    ],
  },
  {
    code: 'P07',
    label: 'Gestion fiscale',
    scope: 'application',
    activities: [
      a('le ', 'Calcul des impôts et taxes'),
      a('la ', 'Préparation des déclarations'),
      a('la ', 'Transmission des déclarations'),
    ],
    note: 'Le calcul se fait dans le logiciel ; le contrôle, la validation et la télétransmission se font dans l’application.',
  },
  {
    code: 'P08',
    label: 'Gestion sociale',
    scope: 'application',
    activities: [
      a('les ', 'Variables de paie'),
      a('les ', 'Bulletins'),
      a('les ', 'Déclarations sociales'),
    ],
    note: 'Le calcul de la paie se fait dans le logiciel de paie ; la collecte, la validation et la télétransmission se font dans l’application.',
  },
  {
    code: 'P09',
    label: 'Clôture comptable',
    scope: 'application',
    activities: [
      a('les ', "Travaux d'inventaire"),
      a('les ', 'Écritures de clôture'),
      a('les ', 'Comptes annuels'),
    ],
  },
  {
    code: 'P10',
    label: 'Validation et supervision',
    scope: 'application',
    activities: [
      a('le ', 'Contrôle qualité'),
      a('la ', "Validation par l'expert-comptable"),
      a('les ', 'Corrections'),
    ],
  },
  {
    code: 'P11',
    label: 'Conseil et accompagnement',
    scope: 'application',
    activities: [
      a("l'", 'Analyse financière'),
      a('le ', 'Reporting'),
      a('les ', 'Recommandations'),
      a('les ', 'Rendez-vous clients'),
    ],
  },
  {
    code: 'P12',
    label: 'Facturation et recouvrement',
    scope: 'mapping_only',
    activities: [
      a('la ', 'Facturation des honoraires'),
      a('le ', 'Suivi des paiements'),
      a('les ', 'Relances de recouvrement'),
    ],
  },
  {
    code: 'P13',
    label: 'Archivage et conformité',
    scope: 'mapping_only',
    activities: [
      a('la ', 'Conservation'),
      a('la ', 'Traçabilité'),
      a('la ', 'Confidentialité'),
      a('les ', 'Obligations réglementaires'),
    ],
  },
  {
    code: 'P14',
    label: 'Pilotage du cabinet',
    scope: 'mapping_only',
    activities: [
      a('la ', 'Charge de travail'),
      a('la ', 'Rentabilité des missions'),
      a('les ', 'Échéances'),
      a('la ', 'Performance'),
    ],
  },
];

export interface PilotActor {
  label: string;
  category: 'internal' | 'external' | 'third_party_system';
  responsibilities: string[];
  stakeholder?: boolean;
  /** Phrase de la description qui le présente (sert de citation). */
  sentence: string;
}

/** Les 8 acteurs du CDC 8.3. */
export const PILOT_ACTORS: PilotActor[] = [
  {
    label: 'Expert-comptable',
    category: 'internal',
    responsibilities: ['Supervision', 'Validation finale', 'Conseil'],
    sentence: "L'expert-comptable assure la supervision, la validation finale et le conseil.",
  },
  {
    label: 'Chef de mission',
    category: 'internal',
    responsibilities: ['Coordination', 'Planification', 'Révision'],
    sentence: 'Le chef de mission assure la coordination, la planification et la révision.',
  },
  {
    label: 'Collaborateur comptable',
    category: 'internal',
    responsibilities: ['Production et traitement comptable'],
    sentence: 'Le collaborateur comptable assure la production et le traitement comptable.',
  },
  {
    label: 'Gestionnaire de paie',
    category: 'internal',
    responsibilities: ['Gestion sociale', 'Production de la paie'],
    sentence: 'Le gestionnaire de paie assure la gestion sociale et la production de la paie.',
  },
  {
    label: 'Assistant administratif',
    category: 'internal',
    responsibilities: ['Gestion documentaire', 'Relances'],
    sentence: "L'assistant administratif assure la gestion documentaire et les relances.",
  },
  {
    label: 'Responsable commercial',
    category: 'internal',
    responsibilities: ['Prospection', 'Contractualisation'],
    sentence: 'Le responsable commercial assure la prospection et la contractualisation.',
  },
  {
    label: 'Client du cabinet',
    category: 'external',
    responsibilities: ['Transmission des documents', 'Validation', 'Consultation'],
    sentence: 'Le client du cabinet transmet les documents, valide et consulte.',
  },
  {
    label: 'Administrateur du système',
    category: 'internal',
    responsibilities: ['Utilisateurs', 'Droits', 'Paramétrage'],
    sentence: "L'administrateur du système gère les utilisateurs, les droits et le paramétrage.",
  },
];

export interface PilotStakeholder {
  label: string;
  category: 'external' | 'third_party_system';
  quote: string;
}

/** Les 4 parties prenantes externes du CDC 8.3. */
export const PILOT_STAKEHOLDERS: PilotStakeholder[] = [
  {
    label: 'Administrations fiscales',
    category: 'external',
    quote: 'les administrations fiscales',
  },
  { label: 'Organismes sociaux', category: 'external', quote: 'les organismes sociaux' },
  { label: 'Banques', category: 'external', quote: 'les banques' },
  { label: 'Logiciels tiers', category: 'third_party_system', quote: 'les logiciels tiers' },
];

export const PILOT_TOOLS = [
  { label: 'Logiciel comptable', quote: 'logiciel comptable' },
  { label: 'Logiciel de paie', quote: 'logiciel de paie' },
] as const;

const SECTOR_SENTENCE =
  'Le cabinet évolue dans le secteur des services professionnels aux entreprises (expertise comptable, fiscalité, gestion sociale, conseil financier).';
const METIER_SENTENCE =
  "Son métier consiste à accompagner les entreprises dans la tenue de leur comptabilité, le respect de leurs obligations fiscales et sociales, l'établissement de leurs comptes annuels et le pilotage de leur performance financière.";
const WORKFLOW_SENTENCE =
  "Le flux principal du dossier client suit dix étapes : prospection et qualification, contractualisation, création du dossier client, collecte documentaire, production comptable, révision et contrôle, validation par l'expert-comptable, déclarations et livrables, facturation et suivi client, archivage et pilotage.";
const PERIMETER_SENTENCE =
  "L'application couvre les étapes 3 à 8 et la partie suivi client de l'étape 9.";
const OBJECTIVES_SENTENCE =
  'Le cabinet vise une application centralisée gérant le cycle de vie du dossier client, avec espace client, GED, workflows paramétrables, affectation et suivi des tâches, circuits de contrôle et de validation, relances et notifications automatiques, intégrations avec les logiciels comptables et bancaires, tableaux de bord, gestion des exceptions et des anomalies, traçabilité complète.';
const STAKEHOLDERS_SENTENCE =
  'Les parties prenantes externes sont les administrations fiscales, les organismes sociaux, les banques et les logiciels tiers.';

const listProse = (items: string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} et ${items.at(-1)}`;

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** Phrase qui présente un macroprocessus, avec sa couverture (citation du macroprocessus). */
export function macroSentence(m: PilotMacro): string {
  const activities = listProse(m.activities.map((x) => `${x.article}${lowerFirst(x.label)}`));
  const scope =
    m.scope === 'application'
      ? 'couverture du MVP : application'
      : 'couverture du MVP : cartographie';
  return `Le processus ${m.code}, ${m.label}, couvre ${activities} ; ${scope}.`;
}

function macroParagraph(m: PilotMacro): string {
  const extra = m.activities
    .filter((x) => x.responsible !== undefined)
    .map((x) => `${x.quote ?? ''}.`);
  return [macroSentence(m), ...extra, ...(m.note === undefined ? [] : [m.note])].join(' ');
}

/** Description du pilote : le CDC 8 (8.1 à 8.5) sous la forme de notes de consultant. */
export const PILOT_DESCRIPTION: string = [
  "Notes du consultant : cabinet d'expertise comptable (pilote).",
  `${SECTOR_SENTENCE} ${METIER_SENTENCE}`,
  'Processus et couverture du MVP.',
  ...PILOT_MACROS.map(macroParagraph),
  `Acteurs. Huit rôles interviennent. ${PILOT_ACTORS.map((x) => x.sentence).join(' ')} ${STAKEHOLDERS_SENTENCE}`,
  `Workflow principal. ${WORKFLOW_SENTENCE} ${PERIMETER_SENTENCE}`,
  `Objectifs de digitalisation. ${OBJECTIVES_SENTENCE}`,
].join('\n\n');

/** Second document, contradictoire avec la description sur le responsable des relances clients. */
export const PILOT_CONTRADICTORY_SENTENCE =
  'Les relances clients (P04) sont assurées par le collaborateur comptable.';

export const PILOT_CONTRADICTORY_DOCUMENT: string = [
  'Note interne du cabinet : organisation de la collecte documentaire.',
  `Chaque semaine, les pièces manquantes sont signalées dans le dossier client. ${PILOT_CONTRADICTORY_SENTENCE}`,
  "L'assistant administratif classe les documents reçus.",
].join('\n\n');

/** Nom du PDF scanné dont la transcription factice est le document contradictoire. */
export const PILOT_SCANNED_DOCUMENT_NAME = 'note-organisation-scannee.pdf';

// ------------------------------------------------------------------ scénarios scriptés

/** Forme minimale d'une requête de pipeline (ce paquet ne dépend pas de `@processia/ai`). */
export interface ScenarioRequest {
  system?: string;
  context?: string;
  messages: { role: string; content: string }[];
  attachments?: { name: string }[];
}

/** Même normalisation (espaces, apostrophes, casse) que la vérification des citations. */
const canon = (s: string): string =>
  s.normalize('NFC').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();

interface Entry {
  quote: string;
  candidate: Record<string, unknown>;
}

function entries(): Entry[] {
  const out: Entry[] = [];
  out.push({
    quote: SECTOR_SENTENCE,
    candidate: {
      kind: 'business_trait',
      label: 'Services professionnels aux entreprises',
      trait: {
        facet: 'sector',
        text: 'Services professionnels aux entreprises (expertise comptable, fiscalité, gestion sociale, conseil financier)',
      },
    },
  });
  out.push({
    quote: METIER_SENTENCE,
    candidate: {
      kind: 'business_trait',
      label: 'Métier du cabinet',
      trait: {
        facet: 'activity_statement',
        text: "Accompagner les entreprises dans la tenue de leur comptabilité, le respect de leurs obligations fiscales et sociales, l'établissement de leurs comptes annuels et le pilotage de leur performance financière",
      },
    },
  });
  for (const m of PILOT_MACROS) {
    out.push({
      quote: macroSentence(m),
      candidate: {
        kind: 'activity',
        label: m.label,
        code: m.code,
        activity: { level: 'macro', scope: m.scope },
      },
    });
    for (const act of m.activities) {
      out.push({
        quote: act.quote ?? `${act.article}${lowerFirst(act.label)}`,
        candidate: {
          kind: 'activity',
          label: act.label,
          activity: {
            level: 'process',
            parent: m.code,
            ...(act.responsible === undefined ? {} : { responsible: act.responsible }),
          },
        },
      });
    }
  }
  for (const x of PILOT_ACTORS) {
    out.push({
      quote: x.sentence,
      candidate: {
        kind: 'actor',
        label: x.label,
        actor: { category: x.category, responsibilities: x.responsibilities },
      },
    });
  }
  for (const s of PILOT_STAKEHOLDERS) {
    out.push({
      quote: s.quote,
      candidate: {
        kind: 'actor',
        label: s.label,
        actor: { category: s.category, responsibilities: [], stakeholder: true },
      },
    });
  }
  for (const t of PILOT_TOOLS) {
    out.push({
      quote: t.quote,
      candidate: { kind: 'tool', label: t.label, tool: { nature: 'software' } },
    });
  }
  out.push({
    quote: WORKFLOW_SENTENCE,
    candidate: {
      kind: 'business_trait',
      label: 'Flux principal du dossier client',
      trait: {
        facet: 'specificity',
        text: 'Dix étapes, de la prospection et qualification à l’archivage et au pilotage',
      },
    },
  });
  out.push({
    quote: PERIMETER_SENTENCE,
    candidate: {
      kind: 'business_trait',
      label: "Périmètre de l'application",
      trait: {
        facet: 'specificity',
        text: "L'application couvre les étapes 3 à 8 et la partie suivi client de l'étape 9",
      },
    },
  });
  out.push({
    quote: OBJECTIVES_SENTENCE,
    candidate: {
      kind: 'business_trait',
      label: 'Objectifs de digitalisation',
      trait: {
        facet: 'specificity',
        text: 'Application centralisée gérant le cycle de vie du dossier client',
      },
    },
  });
  // Second document : une affirmation contradictoire sur le responsable des relances clients.
  out.push({
    quote: PILOT_CONTRADICTORY_SENTENCE,
    candidate: {
      kind: 'activity',
      label: 'Relances clients',
      activity: { level: 'process', parent: 'P04', responsible: 'Collaborateur comptable' },
    },
  });
  return out;
}

const CHUNK_RE = /<morceau id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/morceau>/;

/** `extraction.chunk` : les candidats dont la citation figure dans le morceau soumis. */
export function pilotExtractionChunkScenario(req: ScenarioRequest): unknown {
  const content = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const m = CHUNK_RE.exec(content);
  if (m === null) return { candidates: [] };
  const [, chunkId, text] = m as unknown as [string, string, string];
  const haystack = canon(text);
  const found = entries().filter((e) => haystack.includes(canon(e.quote)));
  return {
    candidates: found.map((e, i) => ({
      ref: `c${i + 1}`,
      chunkId,
      quote: e.quote,
      ...e.candidate,
    })),
  };
}

interface ReconcileData {
  candidates: {
    ref: string;
    kind: string;
    label: string;
    level?: string;
    responsible?: string;
  }[];
  known: { candidateRef: string; existingCode: string }[];
  model: { code: string; kind: string; label: string; level?: string; responsible?: string }[];
}

const DONNEES_RE = /<donnees>\n([\s\S]*?)\n<\/donnees>/;

/**
 * `reconcile` : rapproche les candidats restants par type et libellé, et signale un écart quand
 * un candidat et l'élément existant désignent deux responsables différents pour la même activité.
 */
export function pilotReconcileScenario(req: ScenarioRequest): unknown {
  const content = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const m = DONNEES_RE.exec(content);
  const empty = { matches: [], merges: [], discrepancies: [] };
  if (m === null) return empty;
  const data = JSON.parse(m[1] as string) as ReconcileData;
  const byCode = new Map(data.model.map((e) => [e.code, e]));
  const pairs = new Map(data.known.map((k) => [k.candidateRef, k.existingCode]));
  const matches: { candidateRef: string; existingCode: string }[] = [];
  for (const c of data.candidates) {
    if (pairs.has(c.ref)) continue;
    const same = data.model.find(
      (e) => e.kind === c.kind && canon(e.label) === canon(c.label) && e.level === c.level,
    );
    if (same !== undefined) {
      matches.push({ candidateRef: c.ref, existingCode: same.code });
      pairs.set(c.ref, same.code);
    }
  }
  const discrepancies: Record<string, string>[] = [];
  for (const c of data.candidates) {
    const code = pairs.get(c.ref);
    const existing = code === undefined ? undefined : byCode.get(code);
    if (existing === undefined || c.kind !== 'activity') continue;
    if (
      c.responsible !== undefined &&
      existing.responsible !== undefined &&
      canon(c.responsible) !== canon(existing.responsible)
    ) {
      discrepancies.push({
        existingCode: existing.code,
        candidateRef: c.ref,
        label: `Responsable de « ${existing.label} »`,
        existingClaim: `${existing.label} est assurée par ${existing.responsible}.`,
        candidateClaim: `${existing.label} est assurée par ${c.responsible}.`,
      });
    }
  }
  return { matches, merges: [], discrepancies };
}

/** `extraction.document_visual` : le PDF scanné du pilote est la note contradictoire. */
export function pilotDocumentVisualScenario(req: ScenarioRequest): unknown {
  const name = req.attachments?.[0]?.name ?? '';
  const text =
    name === PILOT_SCANNED_DOCUMENT_NAME
      ? PILOT_CONTRADICTORY_DOCUMENT
      : `Document « ${name} » transcrit : aucun contenu métier reconnu.`;
  return { pages: [{ page: 1, text }] };
}

/** Scénarios du pilote par pipeline, à enregistrer auprès du fournisseur factice. */
export const PILOT_SCENARIOS: Record<string, (req: ScenarioRequest) => unknown> = {
  'extraction.chunk': pilotExtractionChunkScenario,
  reconcile: pilotReconcileScenario,
  'extraction.document_visual': pilotDocumentVisualScenario,
};
