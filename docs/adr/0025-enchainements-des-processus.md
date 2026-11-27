# 0025. Construction des enchaînements des processus (niveaux 2 et 3)

- Statut : acceptée
- Date : 2026-11-27
- Références : spécification 2.3, 2.5, 4.4 (`process.flow`) et section 7 (WP-17), CDC 4.1 et 4.2, ADR 0002, ADR 0014, ADR 0016, ADR 0022, ADR 0024, [PO-2], [PO-124], [PO-150] à [PO-155]

## Contexte

Après la validation du dossier d'analyse, la cartographie demande, pour chaque processus, ses événements, ses passerelles et leurs règles de décision, l'enchaînement de ses tâches (niveau 2) et, pour les tâches détaillées, des étapes avec leurs données, délais, destinataires, indicateurs et règles (niveau 3). Tout ce que l'IA propose reste une hypothèse que le consultant décide (règle non négociable). Le modèle compte des dizaines de processus : le travail doit se faire par lot, avec une progression, sans qu'un processus défaillant bloque les autres, et sans produire de graphe avec impasse (`DEAD_END_BRANCH`).

## Décision

1. **Un appel `process.flow` par processus.** L'entrée est réduite au processus visé (R-2) : ses tâches, les acteurs, les règles et objets de données à réutiliser. Deux modes : `flow` (conteneur `process` : nœuds manquants et flux de séquence, et des tâches seulement si le processus n'en a aucune [PO-150]) et `detail` (une ou plusieurs tâches : étapes, événements, passerelles, flux, objets de données et leurs champs, règles, indicateurs, flux d'information) [PO-151]. La sortie est à plat : `nodes` (tâche, étape, événement, passerelle) avec un `container` (`process` ou le code de la tâche), `edges`, `rules`, `dataObjects`, `indicators`, `informationFlows`, et des références locales (`ref`) ou des codes d'éléments existants.
2. **Le graphe est contrôlé deux fois.** `checkProcessFlow` (contrôle sémantique du pipeline, donc une réparation automatique) reproduit les règles de `checkCoherence` par conteneur : un début, une fin, aucun nœud inatteignable, aucune impasse, passerelle de décision avec règle et conditions, acteurs connus, références résolues. Puis `buildProcessFlowChangeSet` applique le ChangeSet en mémoire (`applyChangeSet`) et refuse d'écrire (`ProcessFlowError`, `FLOW_INCOHERENT`) si le modèle résultant porte `DEAD_END_BRANCH`, `UNREACHABLE_NODE` ou `PROCESS_WITHOUT_START_OR_END`.
3. **Écriture : uniquement des `add`.** Le ChangeSet `process_flow` n'ajoute que des éléments `hypothesis` (origine `ai_knowledge`, justification obligatoire, `aiCallId`, auteur IA) ; il ne modifie aucun élément existant, décidé ou non : les nouveaux éléments référencent les anciens, jamais l'inverse. Les champs de données reçoivent des identifiants persistants (`newId`), un champ n'acceptant pas `tmp:n`. Les codes (`P04.2.1`, `P04.2.1.1`, `EVT-nn`…) sont attribués par le serveur.
4. **Job `analysis.flow`, genre `process_flow`.** `FlowService` (module `MappingModule`) suit le schéma de `GuidedService` : verrou consultatif et un seul lot à la fois (409 `FLOW_IN_PROGRESS`), file pg-boss, progression par `run.progress`. Les cibles sont résolues au lancement (processus sans enchaînement, ou tâches sans niveau 3). Le lot écrit une version par processus (reprise sur `STALE`) ; un processus en échec est consigné et le lot continue. L'issue (`{"failures":[{"code","error"}]}`) est portée par `analysis_runs.error` : aucune migration [PO-154].
5. **Revue.** La revue de WP-14 est réutilisée : les nouveaux éléments apparaissent dans « Hypothèses à examiner ». Deux compléments nécessaires à ces éléments liés entre eux : `planHypothesisRejection` (`packages/model`) rejette en cascade les hypothèses qui ne survivent pas à un rejet et nettoie les références facultatives, ou refuse si un élément décidé en dépend [PO-153] ; `DecisionsService.confirmFields` confirme les champs d'un objet de données avec l'objet [PO-155]. La page Cartographie ajoute la décision groupée par processus ou par tâche [PO-152].
6. **Verrou de phase.** Les trois routes (`GET mapping/processes`, `POST mapping/flows`, `POST mapping/processes/:id/decision`) portent `@Can` puis `@RequiresPhase('mapping')`.
7. **Fournisseur factice.** `PILOT_FLOW_SCENARIOS` (`packages/test-fixtures/src/pilot-flow.ts`) répond pour les 45 processus du pilote et détaille « Relance des pièces manquantes » ; il est enregistré par `FlowService.onModuleInit`. Aucun identifiant de modèle n'est écrit en dur.

## Alternatives écartées

- Un appel pour tout le modèle : contexte trop gros (R-2), un échec perdrait tout le lot.
- Ne contrôler le graphe que dans le contrôle sémantique : une réponse acceptée par erreur pourrait écrire une impasse ; le contrôle sur le modèle résultant est indépendant du pipeline.
- Modifier `ruleIds`, `inputs`, `outputs` des tâches existantes pour les relier : modifierait des éléments confirmés ou validés sans décision humaine.
- Un statut `process_flow_failed` ou une table de résultats par processus : l'état d'un processus se déduit du modèle (il a un enchaînement ou non) ; seul l'échec du dernier lot est à conserver.

## Conséquences

- WP-18 : les jeux de test réalistes existent (45 processus avec enchaînements, un niveau 3) ; les 61 diagrammes du pilote enchaîné se projettent en BPMN (voir le rapport WP-17).
- WP-19 devra proposer la revue par processus (le pilote compte environ 430 hypothèses d'enchaînement) ; WP-20 corrige un enchaînement par dialogue (un processus déjà construit n'est pas reconstruit par le lot).
- Un enchaînement dont le consultant a rejeté un nœud peut rester incomplet : le contrôle de cohérence le signale (`PROCESS_WITHOUT_START_OR_END`), le lot ne le reconstruit pas tant que des éléments existent.
