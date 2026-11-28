import type { BusinessModel, ChangeSet, Element, Finding, Provenance } from '@processia/model';
import { findingKey } from './detectors.js';
import type { FindingCandidate } from './types.js';

export interface BuildFindingsInput {
  model: BusinessModel;
  candidates: readonly FindingCandidate[];
  /** Instant des provenances (ISO). */
  at: string;
  /** Appel IA qui a produit les constats `ai` (provenance). */
  aiCallId?: string | null;
  /** Texte du résumé de version. */
  summary: string;
}

export interface FindingsBuild {
  /** `null` : rien à écrire (tout est déjà dans le modèle, ou rejeté, ou mal localisé). */
  changeSet: ChangeSet | null;
  created: number;
  /** Candidats ignorés : déjà présents ou déjà rejetés. */
  duplicates: number;
  /** Candidats ignorés : un élément localisé n'existe pas dans le modèle. */
  unlocated: number;
}

/** Clés des constats déjà dans le modèle (quel que soit leur statut) ou rejetés par un consultant. */
export function knownFindingKeys(model: BusinessModel): Set<string> {
  const keys = new Set<string>();
  const add = (e: Element): void => {
    if (e.kind === 'finding') keys.add(findingKey(e));
  };
  for (const e of Object.values(model.elements)) add(e);
  for (const r of model.rejectedHypotheses) add(r.element);
  return keys;
}

/**
 * ChangeSet `diagnostic` (spécification 4.4) : chaque constat est une hypothèse que le consultant
 * confirme ou rejette. Les constats d'un détecteur ont l'origine `deterministic_rule` (auteur
 * `system`) ; ceux de l'IA ont l'origine `ai_knowledge` (auteur `ai`), jamais d'un fait. Un
 * constat déjà présent, ou déjà rejeté par un consultant, n'est pas reproposé ; un constat dont un
 * élément localisé n'existe pas (réponse de l'IA erronée) est ignoré, jamais écrit.
 */
export function buildFindingsChangeSet(input: BuildFindingsInput): FindingsBuild {
  const { model, at } = input;
  const known = knownFindingKeys(model);
  const result: FindingsBuild = { changeSet: null, created: 0, duplicates: 0, unlocated: 0 };
  const ops: ChangeSet['ops'] = [];
  for (const c of input.candidates) {
    if (c.location.length === 0 || c.location.some((id) => model.elements[id] === undefined)) {
      result.unlocated += 1;
      continue;
    }
    const key = findingKey(c);
    if (known.has(key)) {
      result.duplicates += 1;
      continue;
    }
    known.add(key);
    const provenance: Provenance =
      c.detection.by === 'rule'
        ? {
            origin: 'deterministic_rule',
            refs: [],
            rationale: c.evidence,
            author: { type: 'system' },
            at,
          }
        : {
            origin: 'ai_knowledge',
            refs: [],
            rationale: c.evidence,
            ...(input.aiCallId === undefined || input.aiCallId === null
              ? {}
              : { aiCallId: input.aiCallId }),
            author: { type: 'ai' },
            at,
          };
    const finding: Finding = {
      id: `tmp:${ops.length + 1}`,
      code: '',
      kind: 'finding',
      label: c.label,
      provenance,
      status: { value: 'hypothesis' },
      meta: { createdInVersion: 0, updatedInVersion: 0 },
      family: c.family,
      type: c.type,
      location: c.location,
      severity: c.severity,
      detection: {
        by: c.detection.by,
        ...(c.detection.detectorId === undefined ? {} : { detectorId: c.detection.detectorId }),
      },
      evidence: c.evidence,
    };
    ops.push({ op: 'add', element: finding });
    result.created += 1;
  }
  if (ops.length > 0) {
    result.changeSet = {
      baseVersion: model.version,
      ops,
      cause: 'diagnostic',
      summary: input.summary,
    };
  }
  return result;
}
