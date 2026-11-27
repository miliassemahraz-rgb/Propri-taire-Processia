# 0017. Extraction, réconciliation et écarts

- Statut : acceptée
- Date : 2026-11-26
- Références : spécification 2.1, 4.4, 4.5 et 7 (WP-12) ; ADR 0006, 0014, 0015, 0016 ; [PO-80] à [PO-84]

## Contexte

WP-12 transforme les morceaux de source (WP-11) en éléments du modèle. Le CDC exige que l'outil cite ses sources, ne tranche pas entre deux sources contradictoires et ne crée jamais de fait confirmé. La spécification 4.4 donne les trois pipelines (`extraction.chunk`, `extraction.document_visual`, `reconcile`) et 4.5 la vérification des citations ; il restait à fixer la répartition entre le modèle d'IA et le code déterministe, l'identité d'un élément (pour ne pas créer de doublons), et la forme du job.

## Décision

1. **Le modèle d'IA propose, le code décide.** `extraction.chunk` renvoie des candidats ; `reconcile` des correspondances, fusions et écarts. Tout le reste est du TypeScript déterministe dans `packages/ai/src/extraction/` : vérification des citations (`text.ts`), fusion et rapprochement (`candidates.ts`), intégration de `reconcile` (`plan.ts`), conversion en ChangeSet (`changeset.ts`). Le code ne dépend ni de la base ni du réseau et se teste sans service.
2. **Vérification des citations (4.5).** Le texte du morceau et la citation sont normalisés de la même façon (NFC, casse, apostrophes et guillemets typographiques, tirets, espaces) avec une table de correspondance vers les positions du texte d'origine. Une citation retrouvée donne `charStart` et `charEnd` ; la `quote` enregistrée est le passage tel qu'il figure dans la source, pas la version du modèle. Une citation non retrouvée rétrograde le candidat en `hypothesis` d'origine `ai_knowledge`, justification « Citation non retrouvée dans la source » [PO-81]. Les citations se vérifient contre `source_chunks.text` lu sous RLS ; `chunkId` est l'identifiant de la ligne `source_chunks`.
3. **Statuts créés.** Jamais `confirmed` : `extracted` (au moins une référence vérifiée) ou `hypothesis` (justification). L'auteur de provenance est `ai`, avec `aiCallId` (journal `ai_calls`). L'écriture passe par `ModelService.commit(missionId, cs, { userId, actor: 'ai', aiCallId })`, `cause: 'extraction'`, identifiants `tmp:n` ; sur `STALE`, le job relit la tête, réconcilie de nouveau et réessaie (trois tentatives).
4. **Identité et idempotence.** Avant `reconcile`, le serveur rapproche les candidats du modèle : même type et même libellé normalisé ; pour un macroprocessus, même code ; pour un processus ou une tâche, même parent (résolu en élément existant) ; pour un trait, même facette. Un candidat rapproché ne crée rien. Relancer l'extraction sur la même source ne produit donc aucun ChangeSet (aucune version). `reconcile` ne reçoit que le modèle non vide ; il ajoute des rapprochements flous, des fusions entre candidats et des écarts [PO-82].
5. **Écarts (CDC 3.1).** `reconcile` signale une affirmation contradictoire ; le code crée un élément `discrepancy` ouvert avec les deux côtés et leurs citations et ne modifie pas l'élément existant. Un candidat contesté n'est pas ajouté comme corroboration. Un écart n'est pas répété pour un même passage [PO-83].
6. **Contrôle sémantique.** `semanticCheck` d'`extraction.chunk` : `chunkId` du morceau soumis, citation ou justification, sous-structure du type, parent résoluble, références uniques ; `reconcile` : candidats et codes connus, aucun candidat apparié deux fois. Une citation fausse n'est pas une erreur de ce contrôle (elle est rétrogradée, pas réparée par un appel supplémentaire).
7. **Job `analysis.extraction`.** File pg-boss ajoutée à `JOB_QUEUES`, consommateur déclaré par `ExtractionService.onModuleInit` (ADR 0016). `analysis_runs` (kind `extraction`) porte statut, progression (`run.progress`) et `result_version` ; les compteurs (créés, extraits, hypothèses, citations rétrogradées, rapprochés, citations ajoutées, écarts) sont dans la notification `analysis.extraction_done`. Pas de migration : `analysis_runs` existait. Déclenchement : `POST /missions/:id/analysis/extractions` (`model.edit`) ; une seule exécution en cours par mission (409) [PO-80]. Les morceaux sont traités dans l'ordre, chacun recevant le résumé du modèle et des candidats des morceaux précédents.
8. **Scénario factice du pilote.** `packages/test-fixtures/src/pilot.ts` produit à la fois la description (CDC 8.1 à 8.5), les citations et les sorties scriptées (`PILOT_SCENARIOS`) : une citation scriptée est par construction une sous-chaîne du texte. Les scénarios sont de vraies fonctions de la requête (ils lisent le morceau ou les données de `reconcile`), enregistrés auprès du fournisseur factice au démarrage de `ExtractionService`. Le paquet ne dépend pas de `@processia/ai` : ses types de requête sont structurels, et la validité des sorties est garantie par le schéma que le fournisseur factice applique à toute réponse.

## Alternatives écartées

- Laisser le modèle décider seul des doublons : coûteux, non reproductible, et l'idempotence ne serait pas vérifiable sans IA réelle.
- Corriger une citation approximative (recherche floue) : une citation qui n'est pas dans la source ne doit pas être présentée comme telle ; la rétrogradation est le comportement de la spécification.
- Enchaîner automatiquement l'extraction au dépôt d'un document : appels IA non demandés [PO-80].
- Ajouter `source_id` et des compteurs à `analysis_runs` : une migration pour des informations déjà portées par `run.progress` (`sourceId`) et la notification.

## Conséquences

- Le rapprochement par libellé exact laisse passer des synonymes en doublons quand `reconcile` ne les détecte pas : ils se règlent par fusion manuelle (WP-13).
- Sur une grosse source, un appel IA par morceau (environ 6 000 jetons) et un `reconcile` unique ; le résumé du modèle croît avec le modèle.
- Une nouvelle révision de la description crée une version qui ne fait qu'ajouter des citations aux éléments existants.
- Les scénarios du pilote sont enregistrés par l'API quand le fournisseur est factice : en développement sans clé, seul un texte reprenant les phrases du pilote produit des candidats.
