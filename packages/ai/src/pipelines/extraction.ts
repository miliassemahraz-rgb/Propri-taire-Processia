import { z } from 'zod';
import { loadPrompt } from '../prompts.js';
import type { PipelineDef } from '../runner.js';
import { normalizeForMatch } from '../extraction/text.js';

/** Types de candidats que l'extraction de l'incrément 1 sait produire. */
export const CANDIDATE_KINDS = [
  'business_trait',
  'actor',
  'activity',
  'tool',
  'glossary_term',
] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

const text = z.string().min(1);

/** Un candidat d'extraction : une citation et un morceau, ou une justification s'il est inféré. */
export const extractionCandidateSchema = z.object({
  /** Identifiant local au morceau (« c1 », « c2 »…), cité par les `parent` des autres candidats. */
  ref: text,
  kind: z.enum(CANDIDATE_KINDS),
  label: text,
  /** Code lisible fourni par la source (« P04 »), le cas échéant. */
  code: text.optional(),
  description: text.optional(),
  chunkId: text,
  /** Citation verbatim du morceau ; absente si le candidat est inféré. */
  quote: text.optional(),
  /** Obligatoire sans citation : pourquoi le modèle l'infère. */
  rationale: text.optional(),
  confidence: z.number().min(0).max(1).optional(),
  trait: z
    .object({
      facet: z.enum(['sector', 'environment', 'specificity', 'summary', 'activity_statement']),
      text,
    })
    .optional(),
  actor: z
    .object({
      category: z.enum(['internal', 'external', 'third_party_system']),
      responsibilities: z.array(text),
      stakeholder: z.boolean().optional(),
    })
    .optional(),
  activity: z
    .object({
      level: z.enum(['macro', 'process', 'task']),
      /** Pour un processus ou une tâche : `ref` d'un candidat du morceau, code ou libellé du parent. */
      parent: text.optional(),
      scope: z.enum(['mapping_only', 'application']).optional(),
      /** Libellé de l'acteur responsable, si la source le désigne. */
      responsible: text.optional(),
    })
    .optional(),
  tool: z
    .object({ nature: z.enum(['software', 'spreadsheet', 'email', 'paper', 'phone', 'other']) })
    .optional(),
  term: z.object({ definition: text, synonyms: z.array(text) }).optional(),
});
export type ExtractionCandidate = z.infer<typeof extractionCandidateSchema>;

export const extractionCandidatesSchema = z.object({
  candidates: z.array(extractionCandidateSchema).max(400),
});
export type ExtractionCandidates = z.infer<typeof extractionCandidatesSchema>;

/** Ligne du résumé du modèle transmis aux pipelines (codes et libellés, spécification 4.4). */
export interface ModelSummaryEntry {
  code: string;
  kind: string;
  label: string;
  /** Niveau d'une activité. */
  level?: string;
  /** Code du parent d'une activité. */
  parentCode?: string;
  /** Libellé de l'acteur responsable d'une activité. */
  responsible?: string;
  /** Vrai pour un candidat d'un morceau précédent, pas encore dans le modèle. */
  pending?: boolean;
}

/** Morceau soumis à l'extraction (la source est immuable, spécification 4.5). */
export interface ChunkInput {
  chunkId: string;
  sourceId: string;
  sourceRevision: number;
  origin: 'free_text' | 'answer' | 'document';
  /** Titre de la source, pour le prompt. */
  title: string;
  /** Texte du morceau, sur lequel les citations sont vérifiées. */
  text: string;
  /** Localisateur du morceau reporté dans les références (page, feuille, cellule, paragraphe). */
  locator: { page?: number; sheet?: string; cell?: string; paragraph?: number };
}

export interface ExtractionChunkInput {
  chunk: ChunkInput;
  model: ModelSummaryEntry[];
  /** Contexte métier libre (secteur, vocabulaire), facultatif. */
  businessContext?: string;
}

/** Balise qui entoure le morceau : le contenu des documents est une donnée (spécification 4.5.6). */
export function chunkMessage(chunk: ChunkInput): string {
  return `<morceau id="${chunk.chunkId}" source="${chunk.title.replace(/"/g, "'")}">\n${chunk.text}\n</morceau>`;
}

export function summaryContext(model: ModelSummaryEntry[], businessContext?: string): string {
  const lines = model.map((e) =>
    [
      e.code,
      e.kind + (e.level === undefined ? '' : `/${e.level}`),
      e.label,
      e.parentCode === undefined ? '' : `parent=${e.parentCode}`,
      e.responsible === undefined ? '' : `responsable=${e.responsible}`,
      e.pending === true ? 'en attente' : '',
    ]
      .filter((p) => p !== '')
      .join(' | '),
  );
  return [
    businessContext === undefined ? '' : `Contexte métier : ${businessContext}`,
    `Éléments déjà connus (${model.length}) :`,
    lines.length === 0 ? '(aucun)' : lines.join('\n'),
  ]
    .filter((p) => p !== '')
    .join('\n');
}

/**
 * `extraction.chunk` (spécification 4.4) : candidats d'un morceau de source. Les citations sont
 * vérifiées côté serveur ; le contrôle sémantique ne porte que sur la cohérence interne de la
 * réponse (la rétrogradation d'une citation non retrouvée n'est pas une erreur).
 */
export const extractionChunkPipeline: PipelineDef<ExtractionChunkInput, ExtractionCandidates> = {
  name: 'extraction.chunk',
  version: '1',
  schemaName: 'ExtractionCandidates',
  outputSchema: extractionCandidatesSchema,
  buildRequest: (input) => ({
    system: loadPrompt('extraction.chunk'),
    context: summaryContext(input.model, input.businessContext),
    messages: [{ role: 'user', content: chunkMessage(input.chunk) }],
    maxOutputTokens: 16_000,
    effort: 'medium',
  }),
  semanticCheck: (output, input) => {
    const issues: { path: string; message: string }[] = [];
    const refs = new Set<string>();
    const known = new Set<string>();
    for (const e of input.model) {
      known.add(normalizeForMatch(e.code));
      known.add(normalizeForMatch(e.label));
    }
    for (const c of output.candidates) {
      refs.add(c.ref);
      known.add(normalizeForMatch(c.label));
      if (c.code !== undefined) known.add(normalizeForMatch(c.code));
    }
    output.candidates.forEach((c, i) => {
      const at = `candidates.${i}`;
      if (c.chunkId !== input.chunk.chunkId) {
        issues.push({
          path: `${at}.chunkId`,
          message: `chunkId « ${c.chunkId} » inconnu : le morceau est « ${input.chunk.chunkId} ».`,
        });
      }
      if (c.quote === undefined && c.rationale === undefined) {
        issues.push({
          path: at,
          message: 'Un candidat porte une citation (quote) ou, s’il est inféré, une justification.',
        });
      }
      if (c.kind === 'business_trait' && c.trait === undefined) {
        issues.push({ path: `${at}.trait`, message: 'Le champ trait est requis.' });
      }
      if (c.kind === 'actor' && c.actor === undefined) {
        issues.push({ path: `${at}.actor`, message: 'Le champ actor est requis.' });
      }
      if (c.kind === 'activity') {
        if (c.activity === undefined) {
          issues.push({ path: `${at}.activity`, message: 'Le champ activity est requis.' });
        } else if (c.activity.level !== 'macro') {
          const parent = c.activity.parent;
          if (parent === undefined) {
            issues.push({
              path: `${at}.activity.parent`,
              message: 'Un processus ou une tâche désigne son parent.',
            });
          } else if (!refs.has(parent) && !known.has(normalizeForMatch(parent))) {
            issues.push({
              path: `${at}.activity.parent`,
              message: `Parent « ${parent} » inconnu : ni candidat du morceau, ni élément connu.`,
            });
          }
        }
      }
      if (c.kind === 'tool' && c.tool === undefined) {
        issues.push({ path: `${at}.tool`, message: 'Le champ tool est requis.' });
      }
      if (c.kind === 'glossary_term' && c.term === undefined) {
        issues.push({ path: `${at}.term`, message: 'Le champ term est requis.' });
      }
    });
    const seen = new Set<string>();
    output.candidates.forEach((c, i) => {
      if (seen.has(c.ref)) {
        issues.push({ path: `candidates.${i}.ref`, message: `Référence « ${c.ref} » en double.` });
      }
      seen.add(c.ref);
    });
    return issues;
  },
};

// ------------------------------------------------------------------ reconcile

/** Candidat tel que présenté au pipeline `reconcile` (déjà vérifié côté serveur). */
export interface ReconcileCandidate {
  ref: string;
  kind: CandidateKind;
  label: string;
  code?: string;
  description?: string;
  /** Citation vérifiée, ou `null` si le candidat est rétrogradé ou inféré. */
  quote: string | null;
  level?: string;
  parentCode?: string;
  responsible?: string;
  trait?: { facet: string; text: string };
}

export interface ReconcileInput {
  candidates: ReconcileCandidate[];
  model: ModelSummaryEntry[];
  /** Correspondances déjà établies par le serveur (même type, même libellé) : `[ref, code]`. */
  known: { candidateRef: string; existingCode: string }[];
}

export const reconcileResultSchema = z.object({
  /** `same_as` : le candidat désigne un élément existant (aucun doublon n'est créé). */
  matches: z.array(z.object({ candidateRef: text, existingCode: text })),
  /** Candidats qui désignent la même chose entre eux : on garde `keepRef`. */
  merges: z.array(z.object({ keepRef: text, duplicateRefs: z.array(text).min(1) })),
  /** Affirmations contradictoires : l'outil signale, il ne tranche pas (CDC 3.1). */
  discrepancies: z.array(
    z.object({
      existingCode: text,
      candidateRef: text,
      label: text,
      existingClaim: text,
      candidateClaim: text,
    }),
  ),
});
export type ReconcileResult = z.infer<typeof reconcileResultSchema>;

export const DONNEES_OPEN = '<donnees>';
export const DONNEES_CLOSE = '</donnees>';

/** `reconcile` (spécification 4.4) : correspondances, fusions et écarts. */
export const reconcilePipeline: PipelineDef<ReconcileInput, ReconcileResult> = {
  name: 'reconcile',
  version: '1',
  schemaName: 'ReconcileResult',
  outputSchema: reconcileResultSchema,
  buildRequest: (input) => ({
    system: loadPrompt('reconcile'),
    messages: [
      {
        role: 'user',
        content: `${DONNEES_OPEN}\n${JSON.stringify({ candidates: input.candidates, known: input.known, model: input.model })}\n${DONNEES_CLOSE}`,
      },
    ],
    maxOutputTokens: 16_000,
    effort: 'medium',
  }),
  semanticCheck: (output, input) => {
    const issues: { path: string; message: string }[] = [];
    const refs = new Set(input.candidates.map((c) => c.ref));
    const codes = new Set(input.model.map((e) => e.code));
    const matched = new Set<string>();
    output.matches.forEach((m, i) => {
      if (!refs.has(m.candidateRef)) {
        issues.push({
          path: `matches.${i}.candidateRef`,
          message: `Candidat inconnu : ${m.candidateRef}.`,
        });
      }
      if (!codes.has(m.existingCode)) {
        issues.push({
          path: `matches.${i}.existingCode`,
          message: `Code inconnu : ${m.existingCode}.`,
        });
      }
      if (matched.has(m.candidateRef)) {
        issues.push({
          path: `matches.${i}.candidateRef`,
          message: `Candidat apparié deux fois : ${m.candidateRef}.`,
        });
      }
      matched.add(m.candidateRef);
    });
    output.merges.forEach((m, i) => {
      for (const r of [m.keepRef, ...m.duplicateRefs]) {
        if (!refs.has(r)) issues.push({ path: `merges.${i}`, message: `Candidat inconnu : ${r}.` });
      }
      if (m.duplicateRefs.includes(m.keepRef)) {
        issues.push({
          path: `merges.${i}`,
          message: 'Le candidat conservé figure aussi parmi les doublons.',
        });
      }
    });
    output.discrepancies.forEach((d, i) => {
      if (!refs.has(d.candidateRef)) {
        issues.push({
          path: `discrepancies.${i}.candidateRef`,
          message: `Candidat inconnu : ${d.candidateRef}.`,
        });
      }
      if (!codes.has(d.existingCode)) {
        issues.push({
          path: `discrepancies.${i}.existingCode`,
          message: `Code inconnu : ${d.existingCode}.`,
        });
      }
    });
    return issues;
  },
};
