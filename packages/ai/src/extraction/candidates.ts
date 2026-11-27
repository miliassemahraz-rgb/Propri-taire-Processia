import type { BusinessModel, Element, SourceRef } from '@processia/model';
import type {
  CandidateKind,
  ChunkInput,
  ExtractionCandidate,
  ModelSummaryEntry,
  ReconcileCandidate,
} from '../pipelines/extraction.js';
import { normalizeForMatch, verifyCitation } from './text.js';

/** Motif de la rétrogradation d'une citation non retrouvée (spécification 4.5, point 3). */
export const CITATION_NOT_FOUND = 'Citation non retrouvée dans la source';

/** Candidat dont la citation a été vérifiée contre le texte du morceau. */
export interface VerifiedCandidate {
  /** Identifiant unique dans l'exécution (`<morceau>:<ref>`). */
  key: string;
  kind: CandidateKind;
  label: string;
  code?: string;
  description?: string;
  trait?: ExtractionCandidate['trait'];
  actor?: ExtractionCandidate['actor'];
  activity?: ExtractionCandidate['activity'];
  tool?: ExtractionCandidate['tool'];
  term?: ExtractionCandidate['term'];
  /** Clé du candidat parent, quand le parent est un candidat du même morceau. */
  parentKey?: string;
  /** Références vérifiées (vide : rétrogradé ou inféré). */
  refs: SourceRef[];
  quote: string | null;
  rationale?: string;
  confidence?: number;
  /** Citation fournie mais non retrouvée : le candidat devient une hypothèse. */
  demoted: boolean;
  /** Aucune citation : inféré par le modèle. */
  inferred: boolean;
  origin: ChunkInput['origin'];
  aiCallId: string | null;
}

export interface ChunkExtraction {
  chunk: ChunkInput;
  candidates: ExtractionCandidate[];
  aiCallId: string | null;
}

/**
 * Vérifie les citations d'un morceau : une citation retrouvée donne la référence avec les
 * positions `charStart` et `charEnd` ; sinon le candidat est rétrogradé en hypothèse.
 */
export function verifyChunkCandidates(
  extraction: ChunkExtraction,
  chunkIndex: number,
): VerifiedCandidate[] {
  const { chunk } = extraction;
  const keyOf = (ref: string): string => `${chunkIndex}:${ref}`;
  const byRef = new Set(extraction.candidates.map((c) => c.ref));
  return extraction.candidates.map((c): VerifiedCandidate => {
    const position =
      c.quote === undefined || c.chunkId !== chunk.chunkId
        ? null
        : verifyCitation(chunk.text, c.quote);
    const refs: SourceRef[] =
      position === null || c.quote === undefined
        ? []
        : [
            {
              sourceId: chunk.sourceId,
              sourceRevision: chunk.sourceRevision,
              chunkId: chunk.chunkId,
              locator: { ...chunk.locator, ...position },
              // La citation est conservée telle que le modèle l'a donnée, retrouvée dans le texte.
              quote: chunk.text.slice(position.charStart, position.charEnd),
            },
          ];
    const parent = c.activity?.parent;
    return {
      key: keyOf(c.ref),
      kind: c.kind,
      label: c.label.trim(),
      ...(c.code === undefined ? {} : { code: c.code.trim() }),
      ...(c.description === undefined ? {} : { description: c.description }),
      ...(c.trait === undefined ? {} : { trait: c.trait }),
      ...(c.actor === undefined ? {} : { actor: c.actor }),
      ...(c.activity === undefined ? {} : { activity: c.activity }),
      ...(c.tool === undefined ? {} : { tool: c.tool }),
      ...(c.term === undefined ? {} : { term: c.term }),
      ...(parent !== undefined && byRef.has(parent) ? { parentKey: keyOf(parent) } : {}),
      refs,
      quote: position === null ? null : (refs[0]?.quote ?? null),
      ...(c.rationale === undefined ? {} : { rationale: c.rationale }),
      ...(c.confidence === undefined ? {} : { confidence: c.confidence }),
      demoted: c.quote !== undefined && position === null,
      inferred: c.quote === undefined,
      origin: chunk.origin,
      aiCallId: extraction.aiCallId,
    };
  });
}

const norm = normalizeForMatch;

function sameRef(a: SourceRef, b: SourceRef): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.sourceRevision === b.sourceRevision &&
    a.locator.charStart === b.locator.charStart &&
    a.locator.charEnd === b.locator.charEnd &&
    a.chunkId === b.chunkId
  );
}

export function unionRefs(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const out = [...a];
  for (const r of b) if (!out.some((x) => sameRef(x, r))) out.push(r);
  return out;
}

/** Libellé ou code du parent d'une activité candidate (texte brut de la source). */
function rawParent(c: VerifiedCandidate, byKey: Map<string, VerifiedCandidate>): string {
  if (c.parentKey !== undefined) {
    const p = byKey.get(c.parentKey);
    if (p !== undefined) return norm(p.code ?? p.label);
  }
  return norm(c.activity?.parent ?? '');
}

/** Identité d'un candidat : deux candidats de même identité désignent le même élément. */
function identity(c: VerifiedCandidate, byKey: Map<string, VerifiedCandidate>): string {
  if (c.kind === 'activity') {
    const level = c.activity?.level ?? 'process';
    if (level === 'macro') return `activity|macro|${norm(c.code ?? c.label)}`;
    return `activity|${level}|${rawParent(c, byKey)}|${norm(c.label)}`;
  }
  if (c.kind === 'business_trait') return `trait|${c.trait?.facet ?? ''}|${norm(c.label)}`;
  return `${c.kind}|${norm(c.label)}`;
}

export interface MergeResult {
  candidates: VerifiedCandidate[];
  /** Clé d'un doublon -> clé du candidat conservé. */
  mergedInto: Map<string, string>;
}

/**
 * Fusion déterministe des candidats identiques (même type, même libellé, même parent) : on garde
 * le premier, on cumule les références. Une citation vérifiée l'emporte sur une rétrogradation.
 */
export function mergeCandidates(all: VerifiedCandidate[]): MergeResult {
  const byKey = new Map(all.map((c) => [c.key, c]));
  const kept = new Map<string, VerifiedCandidate>();
  const mergedInto = new Map<string, string>();
  for (const c of all) {
    const id = identity(c, byKey);
    const first = kept.get(id);
    if (first === undefined) {
      kept.set(id, { ...c, refs: [...c.refs] });
      continue;
    }
    mergedInto.set(c.key, first.key);
    mergeInto(first, c);
  }
  return { candidates: [...kept.values()], mergedInto };
}

/** Intègre `other` dans `into` (références cumulées, statut le plus solide). */
export function mergeInto(into: VerifiedCandidate, other: VerifiedCandidate): void {
  const hadRefs = into.refs.length > 0;
  into.refs = unionRefs(into.refs, other.refs);
  if (!hadRefs && into.refs.length > 0) {
    into.demoted = false;
    into.inferred = false;
    into.quote = into.refs[0]?.quote ?? null;
    into.origin = other.origin;
    into.aiCallId = other.aiCallId;
  }
  into.description ??= other.description;
  into.code ??= other.code;
  into.activity ??= other.activity;
  if (into.activity !== undefined && other.activity !== undefined) {
    into.activity = {
      ...other.activity,
      ...into.activity,
      ...(into.activity.scope === undefined && other.activity.scope !== undefined
        ? { scope: other.activity.scope }
        : {}),
      ...(into.activity.responsible === undefined && other.activity.responsible !== undefined
        ? { responsible: other.activity.responsible }
        : {}),
    };
  }
}

// ------------------------------------------------------------------ modèle existant

/** Résumé du modèle pour les prompts : codes et libellés (spécification 4.4). */
export function summarizeModel(model: BusinessModel): ModelSummaryEntry[] {
  const els = Object.values(model.elements);
  const codeOf = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : model.elements[id]?.code;
  const labelOf = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : model.elements[id]?.label;
  const rank = (e: Element): number => (e.kind === 'activity' ? 0 : e.kind === 'actor' ? 1 : 2);
  return els
    .filter((e) => e.kind !== 'discrepancy')
    .sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code, 'fr', { numeric: true }))
    .map((e): ModelSummaryEntry => {
      const base: ModelSummaryEntry = { code: e.code, kind: e.kind, label: e.label };
      if (e.kind !== 'activity') return base;
      const parent = codeOf(e.parentId);
      const responsible = labelOf(e.responsibleActorId);
      return {
        ...base,
        level: e.level,
        ...(parent === undefined ? {} : { parentCode: parent }),
        ...(responsible === undefined ? {} : { responsible }),
      };
    });
}

/** Résumé des candidats d'un morceau déjà traité, pour que le suivant les connaisse. */
export function summarizeCandidates(candidates: VerifiedCandidate[]): ModelSummaryEntry[] {
  return candidates
    .filter((c) => c.kind === 'activity' || c.kind === 'actor')
    .map((c) => ({
      code: c.code ?? c.key,
      kind: c.kind,
      label: c.label,
      ...(c.activity === undefined ? {} : { level: c.activity.level }),
      pending: true,
    }));
}

export interface ParentTarget {
  existingId?: string;
  candidateKey?: string;
}

/** Cible d'un parent : candidat du même morceau, puis candidat (code ou libellé), puis élément existant. */
export function resolveParent(
  c: VerifiedCandidate,
  candidates: VerifiedCandidate[],
  mergedInto: Map<string, string>,
  model: BusinessModel,
): ParentTarget | null {
  const raw = c.activity?.parent;
  if (raw === undefined) return null;
  if (c.parentKey !== undefined) {
    const key = mergedInto.get(c.parentKey) ?? c.parentKey;
    if (candidates.some((x) => x.key === key)) return { candidateKey: key };
  }
  const n = norm(raw);
  const level = c.activity?.level === 'task' ? ['process', 'task'] : ['macro', 'process'];
  const wanted = (lv: string | undefined): boolean => lv !== undefined && level.includes(lv);
  const inCandidates = candidates.find(
    (x) =>
      x.key !== c.key &&
      x.kind === 'activity' &&
      wanted(x.activity?.level) &&
      (norm(x.code ?? '') === n || norm(x.label) === n),
  );
  if (inCandidates !== undefined) return { candidateKey: inCandidates.key };
  const existing = Object.values(model.elements).find(
    (e) => e.kind === 'activity' && wanted(e.level) && (norm(e.code) === n || norm(e.label) === n),
  );
  return existing === undefined ? null : { existingId: existing.id };
}

/**
 * Rapprochement déterministe avec le modèle : même type et même libellé (ou même code pour un
 * macroprocessus), et, pour un processus, même parent. Il rend l'extraction idempotente.
 */
export function matchExisting(
  candidates: VerifiedCandidate[],
  mergedInto: Map<string, string>,
  model: BusinessModel,
): Map<string, string> {
  const matches = new Map<string, string>();
  const existing = Object.values(model.elements);
  const order = (c: VerifiedCandidate): number =>
    c.kind !== 'activity'
      ? 0
      : c.activity?.level === 'macro'
        ? 0
        : c.activity?.level === 'process'
          ? 1
          : 2;
  for (const c of [...candidates].sort((a, b) => order(a) - order(b))) {
    let found: Element | undefined;
    if (c.kind === 'activity') {
      const level = c.activity?.level ?? 'process';
      if (level === 'macro') {
        found = existing.find(
          (e) =>
            e.kind === 'activity' &&
            e.level === 'macro' &&
            ((c.code !== undefined && norm(e.code) === norm(c.code)) ||
              norm(e.label) === norm(c.label)),
        );
      } else {
        const parent = resolveParent(c, candidates, mergedInto, model);
        const parentId =
          parent?.existingId ??
          (parent?.candidateKey === undefined ? undefined : matches.get(parent.candidateKey));
        if (parentId !== undefined) {
          found = existing.find(
            (e) =>
              e.kind === 'activity' &&
              e.level === level &&
              e.parentId === parentId &&
              norm(e.label) === norm(c.label),
          );
        }
      }
    } else if (c.kind === 'business_trait') {
      found = existing.find(
        (e) =>
          e.kind === 'business_trait' &&
          e.facet === c.trait?.facet &&
          norm(e.label) === norm(c.label),
      );
    } else {
      found = existing.find((e) => e.kind === c.kind && norm(e.label) === norm(c.label));
    }
    if (found !== undefined) matches.set(c.key, found.id);
  }
  return matches;
}

/** Candidat tel que présenté à `reconcile`. */
export function toReconcileCandidate(
  c: VerifiedCandidate,
  byKey: Map<string, VerifiedCandidate>,
): ReconcileCandidate {
  const parent = c.parentKey === undefined ? undefined : byKey.get(c.parentKey);
  const parentCode = parent === undefined ? c.activity?.parent : (parent.code ?? parent.label);
  return {
    ref: c.key,
    kind: c.kind,
    label: c.label,
    ...(c.code === undefined ? {} : { code: c.code }),
    ...(c.description === undefined ? {} : { description: c.description }),
    quote: c.quote,
    ...(c.activity === undefined ? {} : { level: c.activity.level }),
    ...(parentCode === undefined ? {} : { parentCode }),
    ...(c.activity?.responsible === undefined ? {} : { responsible: c.activity.responsible }),
    ...(c.trait === undefined ? {} : { trait: c.trait }),
  };
}
