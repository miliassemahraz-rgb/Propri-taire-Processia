import type {
  Actor,
  Activity,
  BusinessModel,
  BusinessTrait,
  ChangeCause,
  ChangeSet,
  Discrepancy,
  Element,
  GlossaryTerm,
  ModelOp,
  Provenance,
  SourceRef,
  Tool,
} from '@processia/model';
import {
  CITATION_NOT_FOUND,
  resolveParent,
  unionRefs,
  type VerifiedCandidate,
} from './candidates.js';
import { normalizeForMatch } from './text.js';

const norm = normalizeForMatch;

/** Écart signalé par `reconcile`, résolu en identifiants. */
export interface ResolvedDiscrepancy {
  existingId: string;
  candidateKey: string;
  label: string;
  existingClaim: string;
  candidateClaim: string;
}

export interface ExtractionStats {
  candidates: number;
  created: number;
  createdByKind: Record<string, number>;
  /** Éléments créés au statut `extracted` (citation vérifiée). */
  extracted: number;
  /** Éléments créés au statut `hypothesis`. */
  hypotheses: number;
  /** Candidats dont la citation n'a pas été retrouvée (compteur de qualité, spécification 4.5). */
  citationsDemoted: number;
  matched: number;
  /** Références ajoutées à des éléments existants (corroboration). */
  refsAdded: number;
  discrepancies: number;
  /** Candidats ignorés (parent introuvable). */
  skipped: number;
}

export interface BuildInput {
  model: BusinessModel;
  /** Candidats après fusion. */
  candidates: VerifiedCandidate[];
  mergedInto: Map<string, string>;
  /** Clé du candidat -> identifiant de l'élément existant désigné. */
  matches: Map<string, string>;
  discrepancies: ResolvedDiscrepancy[];
  /** Instant des provenances (ISO). */
  at: string;
  /** Texte du résumé du ChangeSet. */
  summary?: string;
  /** Cause du ChangeSet : `extraction` par défaut, `answer` ou `hypotheses` (WP-14). */
  cause?: ChangeCause;
}

export interface BuildResult {
  /** `null` : rien à écrire (extraction déjà intégrée, aucun doublon créé). */
  changeSet: ChangeSet | null;
  stats: ExtractionStats;
}

const emptyStats = (candidates: number): ExtractionStats => ({
  candidates,
  created: 0,
  createdByKind: {},
  extracted: 0,
  hypotheses: 0,
  citationsDemoted: 0,
  matched: 0,
  refsAdded: 0,
  discrepancies: 0,
  skipped: 0,
});

/** Provenance d'un élément créé : `extracted` si la citation est vérifiée, sinon hypothèse. */
function provenanceOf(
  c: VerifiedCandidate,
  at: string,
): { provenance: Provenance; extracted: boolean } {
  const extracted = c.refs.length > 0;
  const rationale = extracted
    ? c.rationale
    : c.demoted
      ? c.rationale === undefined
        ? CITATION_NOT_FOUND
        : `${CITATION_NOT_FOUND}. ${c.rationale}`
      : (c.rationale ?? 'Déduit du texte par l’IA, sans citation');
  return {
    extracted,
    provenance: {
      // Sans source identifiable, l'élément est présenté comme connaissance générale de l'IA.
      origin: extracted ? c.origin : 'ai_knowledge',
      refs: c.refs,
      ...(rationale === undefined ? {} : { rationale }),
      ...(c.confidence === undefined ? {} : { confidence: c.confidence }),
      ...(c.aiCallId === null ? {} : { aiCallId: c.aiCallId }),
      author: { type: 'ai' },
      at,
    },
  };
}

const base = (id: string, c: VerifiedCandidate, prov: Provenance, extracted: boolean) => ({
  id,
  code: c.kind === 'activity' && c.activity?.level === 'macro' ? (c.code ?? '') : '',
  label: c.label,
  ...(c.description === undefined ? {} : { description: c.description }),
  provenance: prov,
  status: { value: extracted ? ('extracted' as const) : ('hypothesis' as const) },
  meta: { createdInVersion: 0, updatedInVersion: 0 },
});

/**
 * Conversion déterministe des candidats réconciliés en ChangeSet `extraction` : jamais de
 * `confirmed`, des éléments `extracted` (citation vérifiée) ou `hypothesis`, des identifiants
 * temporaires `tmp:n` que le serveur résout (spécification 4.4).
 */
export function buildExtractionChangeSet(input: BuildInput): BuildResult {
  const { model, candidates, mergedInto, matches, at } = input;
  const stats = emptyStats(candidates.length);
  const ops: ModelOp[] = [];
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const tmp = new Map<string, string>();
  let counter = 0;
  const nextTmp = (): string => {
    counter += 1;
    return `tmp:${counter}`;
  };
  const idOf = (key: string): string | undefined => matches.get(key) ?? tmp.get(key);

  stats.matched = candidates.filter((c) => matches.has(c.key)).length;
  const fresh = candidates.filter((c) => !matches.has(c.key));
  const level = (c: VerifiedCandidate): number =>
    c.kind === 'activity'
      ? c.activity?.level === 'macro'
        ? 0
        : c.activity?.level === 'process'
          ? 2
          : 3
      : 1;
  // Ordre : macroprocessus, acteurs et autres éléments, puis processus et tâches (parents d'abord).
  const ordered = fresh
    .map((c, i) => ({ c, i }))
    .sort((a, b) => level(a.c) - level(b.c) || a.i - b.i)
    .map((x) => x.c);
  for (const c of ordered) tmp.set(c.key, nextTmp());

  // Acteurs : par libellé, candidats puis modèle (résolution du responsable d'une activité).
  const actorId = (label: string): string | undefined => {
    const n = norm(label);
    const cand = candidates.find((x) => x.kind === 'actor' && norm(x.label) === n);
    if (cand !== undefined) return idOf(cand.key);
    return Object.values(model.elements).find((e) => e.kind === 'actor' && norm(e.label) === n)?.id;
  };

  const siblings = new Map<string, number>();
  for (const c of ordered) {
    const id = tmp.get(c.key) as string;
    const { provenance, extracted } = provenanceOf(c, at);
    let element: Element | undefined;
    switch (c.kind) {
      case 'business_trait': {
        if (c.trait === undefined) break;
        const el: BusinessTrait = {
          ...base(id, c, provenance, extracted),
          kind: 'business_trait',
          facet: c.trait.facet,
          text: c.trait.text,
        };
        element = el;
        break;
      }
      case 'actor': {
        if (c.actor === undefined) break;
        const el: Actor = {
          ...base(id, c, provenance, extracted),
          kind: 'actor',
          category: c.actor.category,
          responsibilities: c.actor.responsibilities,
          ...(c.actor.stakeholder === undefined ? {} : { stakeholder: c.actor.stakeholder }),
        };
        element = el;
        break;
      }
      case 'tool': {
        if (c.tool === undefined) break;
        const el: Tool = {
          ...base(id, c, provenance, extracted),
          kind: 'tool',
          nature: c.tool.nature,
        };
        element = el;
        break;
      }
      case 'glossary_term': {
        if (c.term === undefined) break;
        const el: GlossaryTerm = {
          ...base(id, c, provenance, extracted),
          kind: 'glossary_term',
          term: c.label,
          definition: c.term.definition,
          synonyms: c.term.synonyms,
        };
        element = el;
        break;
      }
      case 'activity': {
        if (c.activity === undefined) break;
        let parentId: string | undefined;
        if (c.activity.level !== 'macro') {
          const target = resolveParent(c, candidates, mergedInto, model);
          parentId =
            target?.existingId ??
            (target?.candidateKey === undefined ? undefined : idOf(target.candidateKey));
          if (parentId === undefined) break;
        }
        const responsibleId =
          c.activity.responsible === undefined ? undefined : actorId(c.activity.responsible);
        const order = parentId === undefined ? undefined : (siblings.get(parentId) ?? 0) + 1;
        if (parentId !== undefined && order !== undefined) siblings.set(parentId, order);
        const el: Activity = {
          ...base(id, c, provenance, extracted),
          kind: 'activity',
          level: c.activity.level,
          ...(parentId === undefined ? {} : { parentId }),
          ...(order === undefined ? {} : { order }),
          ...(c.activity.scope === undefined ? {} : { scope: c.activity.scope }),
          ...(responsibleId === undefined ? {} : { responsibleActorId: responsibleId }),
          raci: responsibleId === undefined ? [] : [{ actorId: responsibleId, role: 'R' }],
          inputs: [],
          outputs: [],
          toolIds: [],
          ruleIds: [],
          execution: 'manual',
        };
        element = el;
        break;
      }
    }
    if (element === undefined) {
      stats.skipped += 1;
      tmp.delete(c.key);
      continue;
    }
    ops.push({ op: 'add', element });
    stats.created += 1;
    stats.createdByKind[c.kind] = (stats.createdByKind[c.kind] ?? 0) + 1;
    if (extracted) stats.extracted += 1;
    else stats.hypotheses += 1;
    if (c.demoted) stats.citationsDemoted += 1;
  }
  // Corroboration : une citation vérifiée d'une autre source s'ajoute aux références de
  // l'élément existant (sauf s'il est déjà validé : on ne modifie pas son contenu).
  const contested = new Set(input.discrepancies.map((d) => d.candidateKey));
  for (const c of candidates) {
    const existingId = matches.get(c.key);
    // Une affirmation contredite n'est pas une corroboration : elle fait l'objet d'un écart.
    if (existingId === undefined || c.refs.length === 0 || contested.has(c.key)) continue;
    const el = model.elements[existingId];
    if (el === undefined || (el.status.value !== 'extracted' && el.status.value !== 'hypothesis'))
      continue;
    const fresher = c.refs.filter(
      (r) =>
        !el.provenance.refs.some(
          (x) => x.sourceId === r.sourceId && x.sourceRevision === r.sourceRevision,
        ),
    );
    if (fresher.length === 0) continue;
    const refs = unionRefs(el.provenance.refs, fresher);
    ops.push({
      op: 'update',
      id: existingId,
      set: { provenance: { ...el.provenance, refs } },
    });
    stats.refsAdded += 1;
  }

  // Écarts entre sources : l'outil signale, il ne tranche pas (CDC 3.1).
  for (const d of input.discrepancies) {
    const c = byKey.get(d.candidateKey);
    const existing = model.elements[d.existingId];
    if (c === undefined || existing === undefined) continue;
    if (alreadySignalled(model, d.existingId, c.refs)) continue;
    const { provenance, extracted } = provenanceOf(c, at);
    const sideA: { claim: string; refs: SourceRef[] } = {
      claim: d.existingClaim,
      refs: existing.provenance.refs,
    };
    const sideB: { claim: string; refs: SourceRef[] } = { claim: d.candidateClaim, refs: c.refs };
    const el: Discrepancy = {
      id: nextTmp(),
      kind: 'discrepancy',
      code: '',
      label: d.label,
      provenance: { ...provenance, refs: unionRefs(c.refs, existing.provenance.refs) },
      status: { value: extracted ? 'extracted' : 'hypothesis' },
      meta: { createdInVersion: 0, updatedInVersion: 0 },
      elementIds: [d.existingId],
      sides: [sideA, sideB],
      state: 'open',
    };
    ops.push({ op: 'add', element: el });
    stats.discrepancies += 1;
  }

  if (ops.length === 0) return { changeSet: null, stats };
  const parts = [
    stats.created > 0 ? `${stats.created} élément(s) extrait(s)` : '',
    stats.discrepancies > 0 ? `${stats.discrepancies} écart(s)` : '',
    stats.refsAdded > 0 ? `${stats.refsAdded} citation(s) ajoutée(s)` : '',
  ].filter((p) => p !== '');
  return {
    changeSet: {
      baseVersion: model.version,
      ops,
      cause: input.cause ?? 'extraction',
      summary: input.summary ?? `Extraction : ${parts.join(', ')}`,
    },
    stats,
  };
}

/** Un écart déjà enregistré pour cette citation (même élément, même passage) n'est pas répété. */
function alreadySignalled(model: BusinessModel, existingId: string, refs: SourceRef[]): boolean {
  return Object.values(model.elements).some(
    (e) =>
      e.kind === 'discrepancy' &&
      e.elementIds.includes(existingId) &&
      e.sides.some((s) =>
        s.refs.some((r) =>
          refs.some(
            (x) =>
              x.sourceId === r.sourceId &&
              x.sourceRevision === r.sourceRevision &&
              x.locator.charStart === r.locator.charStart &&
              x.locator.charEnd === r.locator.charEnd,
          ),
        ),
      ),
  );
}
