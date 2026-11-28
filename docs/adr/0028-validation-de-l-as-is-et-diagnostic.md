# 0028. Validation de l'AS-IS et diagnostic : détecteurs purs, constats en hypothèse, cartographie figée

- Statut : acceptée
- Date : 2026-11-28
- Références : spécification 2.4, 2.7, 4.4 (`diagnostic`, « Décisions sans appel à l'IA ») et section 7 (WP-21), CDC 4.3 et 4.7, ADR 0002, ADR 0014, ADR 0024, ADR 0025, ADR 0026, [PO-180] à [PO-185]

## Contexte

Une fois les enchaînements construits et confirmés (WP-17 à WP-20), le validateur du client valide l'AS-IS (type de soumission `as_is`, déjà géré par le circuit de WP-16), puis la mission passe en phase `transformation` et le diagnostic s'ouvre. Il fallait : un panneau de lecture de la cartographie figée pour le validateur, des détecteurs déterministes, le pipeline `diagnostic`, la page de revue, et le verrou de phase.

## Décision

1. **Détecteurs dans `packages/diagnostic`, purs** (`detectors.ts`). Six fonctions `(BusinessModel) => FindingCandidate[]`, triées par code puis identifiant, sans E/S ni horloge : tâche sans responsable, transfert par papier ou courriel, ressaisie, dépendance à une seule personne, boucle de validation (composantes fortement connexes, Tarjan itératif), décision sans trace. Les seuils sont des constantes nommées [PO-181]. Chaque détecteur a un test positif et un test négatif.
2. **Un seul chemin d'écriture des constats** (`build.ts`, `buildFindingsChangeSet`). Détecteurs et IA produisent des `FindingCandidate` ; le ChangeSet `diagnostic` ne contient que des `add` de constats en `hypothesis` (origine `deterministic_rule`, auteur `system`, ou `ai_knowledge`, auteur `ai`, avec justification) [PO-180]. La clé `type + éléments localisés` écarte les doublons, les constats déjà présents et ceux de l'archive des rejets [PO-183] ; un constat dont un élément localisé n'existe pas est ignoré, jamais écrit. `packages/ai` ne dépend pas de `packages/diagnostic` (matrice des frontières) : les candidats de l'IA ont la même forme structurelle.
3. **Base du diagnostic = la vue des livrables de la tête** (`deliverableView`) [PO-182] : l'AS-IS confirmé ou validé, jamais une hypothèse d'enchaînement non confirmée.
4. **Pipeline `diagnostic`** (`packages/ai`, prompt `diagnostic.fr.md`) : un appel par macroprocessus (contexte réduit, risque R-2), avec les constats déjà trouvés par les règles. La réponse désigne des codes d'éléments ; le contrôle sémantique refuse un code hors du macroprocessus, `resolveDiagnosticOutput` les traduit en identifiants. Le scénario factice du pilote (`packages/test-fixtures/src/pilot-diagnostic.ts`) couvre les quatre familles.
5. **Job `analysis.diagnostic`** (`DiagnosticService`, copie du schéma de `FlowService`) : verrou consultatif, une exécution à la fois (409 `DIAGNOSTIC_IN_PROGRESS`), progression `run.progress` (genre `diagnostic`, ajouté à `GUIDED_RUN_KINDS`), un ChangeSet par lot (version), reprise sur `STALE`. Relancer ne reproduit rien.
6. **Verrou de phase** : `GET diagnostic` et `POST diagnostic/runs` portent `@Can` puis `@RequiresPhase('transformation')` : 409 `PHASE_LOCKED` tant que l'AS-IS n'est pas validé, 403 pour le validateur. Le message de `PHASE_LOCKED` est devenu générique.
7. **Cartographie du validateur** : `GET submissions/:sid/mapping` renvoie le modèle de la version figée d'une soumission `as_is` réduit à `deliveredModel` (la vue des livrables sans écart, constat ni optimisation, sans positions). Le navigateur le lit avec `buildOutline`, `SimpleView` et `TextView` (WP-19) : vues simplifiée et textuelle, sans BPMN complet ni accès à la tête [PO-184]. Le panneau `AsIsPanel` reprend `DossierPanel` avec un onglet « Cartographie » en tête (`leadingTabs`).
8. **Localisation sur la carte** : `diagramOfElement` (`packages/model`) donne le niveau où un élément se dessine ; un lien `cartographie?element=<id>` ouvre la visionneuse sur ce niveau, élément sélectionné, et les marqueurs « Constat » de WP-19 s'affichent.
9. **La page lit le modèle partagé** (`useMissionModel`) : les constats se décident par la route existante `POST elements/:id/decision` (accepter, rejeter), donc en direct pour tous les consultants. Aucune route de lecture des constats n'a été ajoutée.

## Alternatives écartées

- Écrire les constats déterministes `confirmed` : réservé aux acteurs humains par la machine de statuts, et contraire au principe « aucune sortie automatique ne devient un fait sans décision ».
- Un DTO des constats côté API : la page lit déjà le modèle partagé, qui est la source de vérité (ADR 0002).
- Montrer le BPMN complet au validateur : demanderait une route de lecture BPMN sur la version figée et la mise en page de la version figée (positions) ; reporté [PO-184].
- Diagnostiquer la version figée de la soumission : les constats se localiseraient sur une version qui n'est plus la tête [PO-182].

## Conséquences

- `apps/api` dépend de `@processia/diagnostic` (déjà autorisé par `boundaries.mjs`). Pas de migration (0005 libre).
- WP-22 repartira des constats `confirmed` pour proposer des optimisations ; `findingKey` et `knownFindingKeys` servent aussi à ne pas reproposer.
- Le détecteur « décision sans trace » est bruyant sur le pilote (28 constats mineurs) [PO-185].
