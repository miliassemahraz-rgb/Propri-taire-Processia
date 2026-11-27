# 0022. Questionnement guidé, hypothèses et décisions du consultant

- Statut : acceptée
- Date : 2026-11-27
- Références : spécification 1.4 (flux 2 et 3), 2.1, 4.4, WP-14, ADR 0013, ADR 0016, ADR 0017, [PO-120] à [PO-127]

## Contexte

WP-14 ajoute quatre pipelines (`questions`, `answer.integrate`, `hypotheses`, `deliverable.summary`), la file des questions, les décisions du consultant sur les éléments `extracted` et `hypothesis`, et leurs écrans. Il faut décider où tourne le travail asynchrone, comment une décision concurrente est refusée, ce que « rien à écrire » signifie pour une exécution, et comment un rejet n'est jamais suivi d'une reproposition.

## Décision

1. **Une file pg-boss `analysis.guided`** pour les quatre genres, avec des données de tâche discriminées par `kind` (`questions`, `hypotheses`, `summary`, `answer`) ; `GuidedService` la consomme dans le worker et enregistre les scénarios factices du pilote (`PILOT_GUIDED_SCENARIOS`). Chaque lancement crée une ligne `analysis_runs` (kind identique), suivie par `run.progress` comme l'extraction. Un lancement de `questions`, `hypotheses` ou `summary` prend un verrou consultatif par mission et genre : une seule exécution à la fois (409 `GUIDED_IN_PROGRESS`). Les réponses peuvent s'intégrer en parallèle (commit avec reprise sur `STALE`).
2. **Réutilisation de l'extraction** : `answer.integrate` produit des `ExtractionCandidates` ; la source `answer` est créée par `createTextSource` ; la suite est celle de WP-12 (`verifyChunkCandidates`, `mergeCandidates`, `matchExisting`, `buildExtractionChangeSet` avec `cause: 'answer'`, sans `reconcile`). Les hypothèses passent par le même `buildExtractionChangeSet` avec `cause: 'hypotheses'` : des candidats sans référence, donc `hypothesis` avec origine `ai_knowledge` et la justification obligatoire. L'IA n'écrit jamais `confirmed`.
3. **`resultVersion` d'une exécution guidée est `null` quand rien n'a été écrit** (réponse sans élément exploitable, hypothèses déjà présentes). L'interface en tire « aucun nouvel élément ». (L'extraction de WP-12 garde sa convention : version de tête.)
4. **Hypothèses rejetées jamais reproposées**, à trois niveaux : l'entrée du pipeline porte la liste `rejected` (`kind`, `label`) tirée de `rejectedHypotheses` ; le contrôle sémantique refuse une proposition de même nature et de même libellé normalisé (reprise unique, puis échec visible) ; le code déterministe filtre aussi ce cas avant d'écrire.
5. **Décisions** : `POST /missions/:id/elements/:elementId/decision` (`accept`, `correct`, `reject`) construit un ChangeSet de cause `hypothesis_decision` (`set_status` ; `update` puis `set_status` avec l'ancienne valeur pour une correction ; `reject_hypothesis`). L'auteur est `mission_lead` pour le responsable de mission, `consultant` sinon. L'élément est relu dans la transaction qui écrit ; sur `STALE` ou `CHANGESET_INVALID` (le modèle a avancé), la décision est rejugée sur la nouvelle tête : si l'élément n'est plus `extracted`/`hypothesis` ou n'existe plus (rejet archivé), la réponse est 409 `CONFLICT` avec `details.reason = 'ALREADY_DECIDED'`. Seuls les attributs textuels de la liste blanche par nature d'élément sont corrigeables par formulaire [PO-5].
6. **Message sans état `question.updated`** (`pg_notify` sur `mission_messages`), relayé par le serveur de coédition comme `run.progress` : les consultants connectés rechargent la liste des questions sans interrogation.
7. **Classement** : `rankQuestions` (code) trie par `blockingScore` décroissant, ordre de la réponse à égalité, écarte les questions déjà posées ; le rang des questions ouvertes est recalculé en base à chaque génération, réponse ou passage.

## Alternatives écartées

- Une file par pipeline : quatre consommateurs pour un même schéma de tâche, sans bénéfice de priorité.
- Réutiliser `POST model/changes` pour les décisions : le second consultant recevrait `STALE` ou `CHANGESET_INVALID`, pas un message de métier.
- Un verrou de ligne sur l'élément plutôt que la relecture sous `commitInTx` : `lockHead` sérialise déjà toutes les écritures d'une mission.
- Laisser le modèle IA réaliser la déduplication des hypothèses seul : non déterministe, et un rejet doit être respecté même si le fournisseur répète.

## Conséquences

- Tout nouveau pipeline guidé s'ajoute à `GuidedJobData` et à `GuidedService.process`, avec son scénario factice.
- Les propositions d'un libellé corrigé ne sont plus rapprochées de l'hypothèse d'origine ([PO-123]).
- WP-20 (dialogue) pourra réutiliser `DecisionsService` pour la correction de la cartographie ; WP-15 doit exclure les hypothèses des livrables par `deliverableView` (déjà le cas).
