import type { BusinessModel } from '../schema/business-model.js';
import type { Optimisation } from '../schema/optimisation.js';
import { applyChangeSet } from './apply.js';
import { topologicalOrder } from './graph.js';
import type { ApplyOptions, IntegrityError } from './types.js';

export type ComposeError =
  | { code: 'DEPENDENCY_CYCLE'; cycle: string[] }
  | { code: 'DEPENDENCY_NOT_ACCEPTED'; optimisationId: string; dependencyIds: string[] }
  | { code: 'APPLY_FAILED'; optimisationId: string; errors: IntegrityError[] };

export type ComposeResult =
  { ok: true; model: BusinessModel; order: string[] } | { ok: false; error: ComposeError };

/**
 * Recompose le TO-BE (spécification 2.5) : applique les ChangeSets des optimisations acceptées à
 * l'AS-IS, dans l'ordre topologique de leurs dépendances puis par code. Pur et déterministe.
 * Le résultat est un `BusinessModel` en version `asIs.version + 1` ; les éléments de diagnostic
 * (constats, optimisations) y restent tels quels. Échoue si le graphe est cyclique, si une
 * optimisation acceptée dépend d'une optimisation non acceptée, ou si un ChangeSet ne s'applique pas.
 * Les ajouts des optimisations sont des propositions de l'IA déjà validées : leur statut de création
 * n'est pas recontrôlé.
 */
export function tryComposeToBe(
  asIs: BusinessModel,
  accepted: readonly Optimisation[],
  options: ApplyOptions = {},
): ComposeResult {
  const acceptedIds = new Set(accepted.map((o) => o.id));
  for (const o of accepted) {
    const missing = o.dependsOn.filter((d) => !acceptedIds.has(d));
    if (missing.length > 0) {
      return {
        ok: false,
        error: { code: 'DEPENDENCY_NOT_ACCEPTED', optimisationId: o.id, dependencyIds: missing },
      };
    }
  }
  const topo = topologicalOrder(
    accepted.map((o) => ({ id: o.id, code: o.code, dependsOn: o.dependsOn })),
  );
  if (!topo.ok) return { ok: false, error: { code: 'DEPENDENCY_CYCLE', cycle: topo.cycle } };

  const targetVersion = asIs.version + 1;
  let model: BusinessModel = asIs;
  for (const id of topo.order) {
    const opt = accepted.find((o) => o.id === id) as Optimisation;
    const res = applyChangeSet(
      model,
      { ...opt.changeSet, baseVersion: model.version },
      { ...options, skipBaseCheck: true, targetVersion, trustedAdds: true },
    );
    if (!res.ok)
      return { ok: false, error: { code: 'APPLY_FAILED', optimisationId: id, errors: res.errors } };
    model = res.model;
  }
  return { ok: true, model: { ...model, version: targetVersion }, order: topo.order };
}

export class ComposeToBeError extends Error {
  readonly detail: ComposeError;
  constructor(detail: ComposeError) {
    super(`Recomposition du TO-BE impossible : ${detail.code}`);
    this.name = 'ComposeToBeError';
    this.detail = detail;
  }
}

/** Version de `tryComposeToBe` conforme à la signature de la spécification ; lève `ComposeToBeError`. */
export function composeToBe(
  asIs: BusinessModel,
  accepted: readonly Optimisation[],
  options: ApplyOptions = {},
): BusinessModel {
  const r = tryComposeToBe(asIs, accepted, options);
  if (!r.ok) throw new ComposeToBeError(r.error);
  return r.model;
}
