# 0024. Circuit de validation, commentaires partagés et courriels

- Statut : acceptée
- Date : 2026-11-27
- Références : spécification 2.7, 3.5 et 5, WP-16, ADR 0014, ADR 0016, ADR 0023, [PO-7], [PO-19], [PO-31], [PO-52], [PO-135], [PO-140] à [PO-146]

## Contexte

Le validateur du client lit, commente et valide le dossier d'analyse (puis l'AS-IS et le TO-BE). Il ne doit jamais lire le modèle de travail ni une hypothèse (PO-52), la validation doit passer par le seul chemin autorisé vers le statut `validated` (`ModelService.commit` avec l'acteur `validator` et la soumission), et les modifications ultérieures d'un élément validé doivent lui être signalées en application et par courriel (PO-19).

## Décision

1. **Soumission = version figée.** `ValidationSubmission` enregistre la version de tête (`model_version`), la liste des hypothèses exclues et les exports joints (`artifact_ids`). Une transaction qui verrouille la ligne de la mission (`lockHead`) sérialise soumission, validation et commits du modèle. Une nouvelle soumission d'un même type passe la précédente à `superseded` dans la même transaction ; `round` croît par type.
2. **Lecture du validateur = version figée filtrée.** Les routes `GET submissions/:id/document` et `…/elements` chargent l'instantané de `model_version` et le filtrent par `deliverableView` (via `buildDossier` et `deliveredElements`). Le validateur n'a ni `mission.read_workspace` ni `model.edit` : `GET model`, `GET exports`, `GET deliverables` et toutes les routes d'édition lui répondent 403.
3. **Validation = ChangeSet `validation`.** Dans une seule transaction : éléments livrés, inchangés depuis la version figée et au statut `extracted` ou `confirmed`, passent à `validated` (`set_status`, acteur `validator`, `submissionId`) ; la soumission passe à `validated` ; la phase avance (`analysis_dossier` → `mapping`, `as_is` → `transformation`). Les éléments modifiés depuis la soumission gardent leur statut [PO-140]. Le TO-BE se valide élément par élément (WP-23) : la validation en bloc est refusée.
4. **Le validateur ne « refuse » pas** [PO-7] : il commente, le consultant soumet de nouveau (la nouvelle soumission remplace la précédente). Un consultant peut aussi retirer une soumission en attente.
5. **Exports joints.** `ExportsService.start` accepte une version figée et une soumission ; la tâche `export.create` écrit l'artefact avec `purpose = 'submission'` (hors de la liste « Fichiers produits » de la page Livrables) et ajoute son identifiant à `artifact_ids` par une mise à jour jsonb atomique. Trois exports (Word, PDF, Excel) partent à la soumission ; le téléchargement par URL présignée vérifie l'appartenance à la soumission.
6. **Commentaires.** `comments.submission_id` distingue le fil partagé avec le validateur (version figée) du commentaire interne de l'équipe, invisible du validateur [PO-142]. Un commentaire du validateur n'accepte comme cible qu'un élément de la version figée (jamais une hypothèse), un livrable ou la soumission. L'événement part en temps réel aux consultants (`comment.created`, `submission.updated`, `notice.created` relayés par le serveur de coédition sur `mission_messages`) ; le validateur, qui n'utilise pas Yjs, relit la liste toutes les 5 secondes.
7. **Courriels par boîte d'envoi.** Les notifications portent `email_pending` ; le worker les relève chaque seconde (`FOR UPDATE SKIP LOCKED`) et envoie par nodemailer (Mailpit en local) : jamais avant la validation de la transaction de l'événement, un seul essai, regroupement par version pour les signalements (une notification par version, PO-51).
8. **Verrou de phase.** `@RequiresPhase(phase)` est évalué par `PolicyGuard` après `@Can` ; il renvoie 409 `PHASE_LOCKED` [PO-146]. La phase minimale après validation reste imposée par `PHASE_REGRESSION` (PO-31, lecture de `validation_submissions` au statut `validated`).

## Alternatives écartées

- Valider l'instantané figé plutôt que la tête : crée une version qui ramène en arrière le travail du consultant.
- Un service d'envoi appelé depuis `ModelService.persist` : le courriel pourrait partir avant la validation de la transaction.
- Faire lire le validateur sur le modèle de travail avec un filtre : une seule erreur de filtre exposerait les hypothèses ; la version figée limite l'exposition à une vue construite par `deliverableView`.

## Conséquences

- WP-21 et WP-23 branchent leur panneau dans `PANELS` (`apps/web/src/components/validation-page.tsx`) et réutilisent `SubmissionsService` ; le TO-BE ajoute `optimisation_decisions` sans changer le circuit.
- Les routes de cartographie (WP-17 à WP-20) portent `@RequiresPhase('mapping')`.
- Pas de reprise des courriels échoués ni de résumé quotidien (PO-143).
