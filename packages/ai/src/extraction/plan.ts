import type { BusinessModel } from '@processia/model';
import type { ReconcileInput, ReconcileResult } from '../pipelines/extraction.js';
import {
  mergeInto,
  summarizeModel,
  toReconcileCandidate,
  type VerifiedCandidate,
} from './candidates.js';
import type { ResolvedDiscrepancy } from './changeset.js';

/** Entrée du pipeline `reconcile` : candidats, résumé du modèle, correspondances du serveur. */
export function prepareReconcileInput(
  candidates: VerifiedCandidate[],
  matches: Map<string, string>,
  model: BusinessModel,
): ReconcileInput {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const known: ReconcileInput['known'] = [];
  for (const [key, id] of matches) {
    const code = model.elements[id]?.code;
    if (code !== undefined) known.push({ candidateRef: key, existingCode: code });
  }
  return {
    candidates: candidates.map((c) => toReconcileCandidate(c, byKey)),
    model: summarizeModel(model),
    known,
  };
}

export interface ReconciledPlan {
  candidates: VerifiedCandidate[];
  mergedInto: Map<string, string>;
  matches: Map<string, string>;
  discrepancies: ResolvedDiscrepancy[];
}

/** Intègre la réponse de `reconcile` : correspondances, fusions et écarts résolus en identifiants. */
export function applyReconcileResult(
  state: {
    candidates: VerifiedCandidate[];
    mergedInto: Map<string, string>;
    matches: Map<string, string>;
  },
  result: ReconcileResult,
  model: BusinessModel,
): ReconciledPlan {
  const idByCode = new Map(Object.values(model.elements).map((e) => [e.code, e.id]));
  const mergedInto = new Map(state.mergedInto);
  const matches = new Map(state.matches);
  let candidates = state.candidates.map((c) => ({ ...c, refs: [...c.refs] }));

  for (const m of result.matches) {
    const id = idByCode.get(m.existingCode);
    if (id !== undefined && !matches.has(m.candidateRef)) matches.set(m.candidateRef, id);
  }
  for (const merge of result.merges) {
    const keep = candidates.find((c) => c.key === merge.keepRef);
    if (keep === undefined) continue;
    for (const dupKey of merge.duplicateRefs) {
      const dup = candidates.find((c) => c.key === dupKey);
      if (dup === undefined) continue;
      mergeInto(keep, dup);
      mergedInto.set(dupKey, keep.key);
      const dupMatch = matches.get(dupKey);
      if (dupMatch !== undefined && !matches.has(keep.key)) matches.set(keep.key, dupMatch);
      matches.delete(dupKey);
      candidates = candidates.filter((c) => c.key !== dupKey);
    }
  }
  const discrepancies: ResolvedDiscrepancy[] = [];
  for (const d of result.discrepancies) {
    const existingId = idByCode.get(d.existingCode);
    const key = mergedInto.get(d.candidateRef) ?? d.candidateRef;
    if (existingId === undefined || !candidates.some((c) => c.key === key)) continue;
    discrepancies.push({
      existingId,
      candidateKey: key,
      label: d.label,
      existingClaim: d.existingClaim,
      candidateClaim: d.candidateClaim,
    });
  }
  return { candidates, mergedInto, matches, discrepancies };
}
