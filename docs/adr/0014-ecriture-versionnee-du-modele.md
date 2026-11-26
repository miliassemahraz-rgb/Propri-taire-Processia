# 0014. Écriture versionnée du modèle : verrou de la mission, rebasage, retour arrière

- Statut : acceptée
- Date : 2026-11-26
- Références : spécification 2.5, 3.2, 5.3 et 5.4, [PO-50] à [PO-53], WP-08, ADR 0002 et 0003

## Contexte

Le modèle est un document JSON dont chaque version est un instantané complet (ADR 0002). Plusieurs auteurs (consultants, pipelines IA, validateur) écrivent en parallèle ; la version N+1 doit être cohérente, indexée par élément, signalée au serveur de coédition et signalée au validateur si un élément validé change.

## Décision

- **Un seul point d'écriture** : `ModelService.commitInTx(tx, missionId, cs, author, options)` (et `commit(missionId, …)` qui ouvre `withMission` pour les tâches de fond). Les contrôleurs passent par `ctx.run`.
- **Sérialisation par verrou de ligne** : la ligne `missions` est lue `FOR UPDATE` au début du commit. Deux commits d'une même mission s'exécutent l'un après l'autre ; pas de boucle de nouvelle tentative et pas de contrainte d'unicité pour détecter la course.
- **Contrôle optimiste** : `cs.baseVersion` est comparé à `missions.head_version`. En retard, les diffs des versions intercalées (`model_versions.diff`) sont chargés et `rebase()` (WP-03) est appelé ; succès = le ChangeSet rebasé est appliqué (la réponse porte `rebasedFrom`), conflit = `409 STALE` avec `details.conflicts` et `details.headVersion`. Une version de départ future est aussi `STALE`. `applyChangeSet` rejeté = `422 CHANGESET_INVALID`.
- **Une version = une transaction** : `model_versions` (instantané, ChangeSet appliqué, diff), `model_version_elements` (`added`, `updated`, `removed`, `status` quand le seul champ modifié est le statut), `missions.head_version`, signalements, notification, `pg_notify('mission_events', {missionId, version})`. Le `pg_notify` n'est délivré qu'à la validation de la transaction.
- **Version 0** : une mission sans version a la tête 0 et un modèle vide (non stocké).
- **Signalements** : déduits des modèles avant et après (pas des opérations). Un élément `validated` de la version précédente qui n'est plus `validated` dans la nouvelle, ou qui est retiré, produit une ligne `post_validation_notices` (soumission = `status.validatedInSubmission`) ; une notification par version est créée pour le validateur de la mission [PO-51].
- **Retour arrière** : pas d'opération supplémentaire dans le méta-modèle. `buildRollback(head, cible)` (fonction pure, `apps/api/src/model/rollback.ts`) produit le modèle N+1 ; le ChangeSet enregistré est `{ ops: [], cause: 'rollback', rollbackTo: K }` et le diff porte le contenu du changement. Règles de validation : [PO-50].
- **Propositions** (`change_proposals`) : l'aperçu est calculé sur la version de départ ; `apply` rebase puis commit dans un savepoint ; en cas de `STALE` ou `CHANGESET_INVALID` la proposition passe en `stale` (transaction validée) puis la réponse est `409`. Après chaque commit, les propositions `pending` dont la version de départ est dépassée sont revérifiées par `rebase()` et passent en `stale` si elles ne se rebasent plus.

## Alternatives écartées

- Boucle « lire la tête, insérer, réessayer sur violation d'unicité » : plus de code, comportements de course moins prévisibles, et le rebasage doit de toute façon relire la tête.
- Verrou consultatif PostgreSQL : équivalent au verrou de ligne, sans le bénéfice de lire la tête dans la même instruction.
- Opération `rollback` dans `ModelOp` : modifie les schémas de `packages/model` (hors périmètre de WP-08) pour un cas que le diff représente déjà.
- Signalements calculés à partir des opérations du ChangeSet : manquerait les cascades, les retraits et le retour arrière.

## Conséquences

- Le débit d'écriture est limité à un commit à la fois par mission (acceptable : quelques consultants, ADR 0004).
- Chaque version stocke un instantané complet (risque R-6 de la spécification) ; le coût du chargement de la tête et des diffs est celui d'un `SELECT` par version.
- Les modules suivants (dialogue WP-20, extraction WP-12, validation WP-16) appellent `ModelService` ; une validation passe `options.submissionId` et `actor: 'validator'`.
- Le serveur de coédition (WP-10) écoute `mission_events` ; la charge utile ne contient que `missionId` et `version`.
