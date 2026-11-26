import {
  diffModels,
  transitionStatus,
  type BusinessModel,
  type Element,
  type ModelDiff,
} from '@processia/model';

export interface RollbackBuild {
  model: BusinessModel;
  diff: ModelDiff;
}

/**
 * Modèle de la version N+1 d'un retour arrière : le contenu de la version K remplace celui de la
 * tête (spécification 2.5). Fonction pure. Tout élément dont le contenu change par rapport à la
 * tête et que K porte au statut `validated` passe à `confirmed` avec `changedAfterValidation` :
 * une validation ne survit pas à une modification de contenu. Les signalements au validateur se
 * déduisent ensuite du diff, comme pour tout autre ChangeSet.
 */
export function buildRollback(
  head: BusinessModel,
  target: BusinessModel,
  options: { at: string },
): RollbackBuild {
  const version = head.version + 1;
  const restored = structuredClone(target);
  restored.version = version;
  restored.missionId = head.missionId;

  // Contenu comparé hors statut et métadonnées : seul le contenu invalide une validation.
  const contentDiff = diffModels(withoutStatus(head), withoutStatus(restored));
  const changed = new Set<string>([...contentDiff.added, ...contentDiff.modified.map((m) => m.id)]);

  for (const id of changed) {
    const el = restored.elements[id];
    if (el === undefined) continue;
    const next = { ...el, meta: { ...el.meta, updatedInVersion: version } } as Element;
    if (el.status.value === 'validated') {
      const t = transitionStatus(el.status, 'confirmed', {
        actor: 'system',
        at: options.at,
        version,
      });
      if (t.ok && !t.rejected) next.status = t.status;
    }
    restored.elements[id] = next;
  }

  // Une validation de la tête qui ne survit pas au retour arrière reste tracée sur l'élément.
  for (const [id, before] of Object.entries(head.elements)) {
    const el = restored.elements[id];
    if (before.status.value !== 'validated' || el === undefined) continue;
    if (el.status.value === 'validated') continue;
    restored.elements[id] = {
      ...el,
      status: { ...el.status, changedAfterValidation: { version, at: options.at } },
    } as Element;
  }

  return { model: restored, diff: diffModels(head, restored) };
}

function withoutStatus(model: BusinessModel): BusinessModel {
  const elements: Record<string, Element> = {};
  for (const [id, el] of Object.entries(model.elements)) {
    elements[id] = { ...el, status: { value: 'confirmed' } } as Element;
  }
  return { ...model, elements };
}
