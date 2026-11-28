# 0027. Modification par dialogue : actions d'édition, ChangeSet déterministe, aperçu local

- Statut : acceptée
- Date : 2026-11-28
- Références : spécification 4.4 (`model.edit`), 5.4, 6.3 et section 7 (WP-20), CDC 4.2, ADR 0002, ADR 0014, ADR 0015, ADR 0026, [PO-170] à [PO-175]

## Contexte

La cartographie ne se modifie que par dialogue (CDC 4.2) : le consultant écrit une consigne, voit un aperçu (différences, incohérences créées) et applique ou abandonne. Les tables `change_proposals` et `dialogue_messages`, `ProposalsService` (aperçu, application, `stale`) et le retour arrière existaient déjà (WP-08). Il restait le pipeline, le fil de dialogue et l'interface.

## Décision

1. **L'IA ne décrit pas d'opérations sur le modèle.** `model.edit` renvoie un `EditPlan` : une question de clarification ou une liste d'actions de haut niveau (`insert_task`, `reassign`, `rename`, `remove`, `add_exception`, `set_indicator`) qui désignent les éléments par leur code. `buildEditChangeSet` (`packages/ai/src/edit`) les traduit de façon déterministe en `ChangeSet` (cause `dialogue_edit`) : recâblage des enchaînements, raccord à la suppression (`planRemoval`, `packages/model`), références nettoyées, puis revérification par `applyChangeSet`. Un code inconnu, un acteur inconnu ou deux actions qui écrivent la même valeur sont refusés avec un message en français.
2. **Contexte réduit** (risque R-2) : `buildEditInput` envoie le détail du processus affiché (niveaux 2 et 3 : nœuds, flux, règles, indicateurs) et, aux niveaux 0 et 1, la seule liste compacte des processus et de leurs tâches. L'élément sélectionné et les derniers échanges de clarification complètent le contexte.
3. **Statuts** [PO-170] : les éléments créés sont `confirmed`, d'origine `consultant`, avec l'identifiant de l'appel IA en provenance ; les éléments corrigés passent à `confirmed` avec la valeur précédente. L'application de la proposition est la décision humaine : aucun ChangeSet n'est écrit avant `POST proposals/:id/apply`.
4. **Exécution synchrone** [PO-171] : `DialogueService` appelle l'IA dans la requête, hors transaction, puis ouvre une transaction qui relit la tête, traduit le plan sur la version actuelle, crée la proposition (`ProposalsService.create`) et le message de l'assistant. Une erreur de l'IA ou un plan impossible devient un message du fil.
5. **Concurrence** : le comportement de WP-08 est conservé (rebase si les éléments touchés sont disjoints, sinon `stale`). Nouveautés : `preview` renvoie le ChangeSet rebasé (le navigateur l'applique à la tête), `proposal.updated` est diffusé (`pg_notify` puis `broadcastStateless`) à chaque changement d'état, et `POST dialogue/proposals/:id/regenerate` relance le pipeline avec la consigne d'une proposition périmée.
6. **Aperçu calculé dans le navigateur** [PO-174] : `applyChangeSet` (fonction pure de `@processia/model`) s'applique au modèle partagé ; l'aperçu montre avant et après en vue simplifiée, avec marqueurs en texte (Ajouté, Modifié, Supprimé). Les routes du dialogue portent `@Can` puis `@RequiresPhase('mapping')`.

## Alternatives écartées

- Faire écrire des `ModelOp` par l'IA : fragile (références croisées, raccords de flux) et difficile à valider ; les actions de haut niveau sont testables sans IA.
- Un job pg-boss par consigne : inutile avec le fournisseur factice, et le consultant attend la réponse ; à reprendre si l'IA réelle est lente [PO-171].
- Produire le BPMN « après » côté API : coûteux (mise en page elkjs) pour un aperçu éphémère [PO-174].

## Conséquences

- `packages/ai` dépend de `planRemoval` (nouvelle fonction du modèle) ; `packages/test-fixtures` porte le scénario factice `model.edit` (`pilot-edit.ts`, six consignes types, clarifications).
- La proposition `stale` reste dans l'historique ; « Régénérer » en crée une nouvelle.
- Pas de migration (tables de WP-04 suffisantes).
