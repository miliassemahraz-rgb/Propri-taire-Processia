# 0016. Sources, file de tâches pg-boss et extraction de texte

- Statut : acceptée
- Date : 2026-11-26
- Références : spécification 1.1, 1.3, 3.3, 4.5, 4.6, 5.1 et 7 (WP-11) ; ADR 0005 ; [PO-24], [PO-70] à [PO-73]

## Contexte

WP-11 branche le dépôt de documents, le stockage S3, l'extraction de texte et le découpage, avec une tâche asynchrone `ingest.document`. L'ADR 0005 a choisi pg-boss sans Redis ; il restait à fixer la connexion, le démarrage, la forme du worker, la diffusion de la progression et le choix du traitement visuel.

## Décision

1. **Connexion pg-boss.** Le schéma `pgboss` est créé et migré par pg-boss lui-même. Le rôle applicatif `processia_app` n'a pas le droit de créer un schéma ; `JobsService` ouvre donc pg-boss avec l'URL du rôle **propriétaire** (`DATABASE_OWNER_URL`, déduite de `DATABASE_URL` hors production). Le schéma ne contient aucune donnée de mission : les données de tâche ne portent que des identifiants (mission, source, exécution, utilisateur) ; le traitement relit tout sous RLS avec `withMission`.
2. **Démarrage paresseux.** `JobsService` démarre pg-boss au premier `send` ou à `startConsuming()`. Le processus HTTP produit seulement ; le worker (`worker.ts`, contexte d'application Nest sur les mêmes modules que l'API) appelle `startConsuming()`. Les modules déclarent leurs consommateurs avec `addConsumer(file, handler)` dans `onModuleInit` : les WP suivants (`analysis.extraction`, exports) font de même, sans toucher au worker.
3. **Files** : une file par type de tâche, nommée `<domaine>.<action>` (`ingest.document`), créée avec deux reprises. Le traitement attrape ses propres erreurs et les consigne (statut `failed`) : pg-boss ne rejoue donc que les tâches interrompues (arrêt du worker), et le traitement est idempotent (les morceaux sont remplacés).
4. **Progression `run.progress`.** Chaque étape met à jour `analysis_runs` (kind `ingest`, statuts `queued`, `running`, `succeeded`, `failed`, progression 0 à 100) et émet `pg_notify('mission_messages', {type:'run.progress', …})` dans la même transaction. Le serveur de coédition (WP-10) écoutera ce canal et le relaiera par `broadcastStateless` (spécification 5.1). Le canal est distinct de `mission_events` (versions du modèle) pour ne pas changer la forme des charges existantes. `GET /missions/:id/runs/:runId` lit le même état.
5. **Stockage S3.** Clé `missions/<missionId>/sources/<sourceId>/<nom>` dans `S3_BUCKET_SOURCES`. L'objet est écrit dans la transaction qui insère la source (annulation = suppression de l'objet). Les URL de téléchargement sont présignées (5 minutes) et ne sont délivrées qu'après `PolicyGuard`, la source étant relue sous RLS.
6. **Type et taille [PO-24].** `file-type` détermine le type par signature ; l'extension doit désigner le même type (un texte brut doit être de l'UTF-8 sans octet nul). Limite 50 Mo (`multer` reçoit 50 Mo + 1 octet : le dépassement exact lève `FILE_TOO_LARGE` 413, un flux plus gros est coupé par multer, 413 aussi). Pas d'antivirus.
7. **Traitement visuel.** Un PDF sans texte exploitable (moins de 20 caractères par page en moyenne) ou une image est transcrit par `extraction.document_visual` (pièce jointe, spécification 4.6) **si** la configuration IA active du client déclare la capacité `documents` ; sinon la source reçoit `text_status = 'unreadable'`, l'exécution échoue avec `SOURCE_UNREADABLE` et l'auteur reçoit une notification `source.unreadable` [PO-70]. Le pipeline et son prompt sont définis dans `packages/ai` ; son scénario factice du pilote reste à WP-12.
8. **Textes figés.** `SourcesService.createTextSource` fige un texte (description, plus tard réponses) en source immuable avec ses morceaux ; la description vient de `yjs_documents` (`mission:<id>:workspace`, `Y.XmlFragment description`). Un verrou consultatif par mission et titre garantit des révisions consécutives.
9. **Localisateurs** (`source_chunks.locator`) : `page` (`pageStart`, `pageEnd`), `paragraph` (`paragraphStart`, `paragraphEnd`, titre courant), `cell` (`sheet`, plage `A1:C9`, lignes), `line`. Un morceau (environ 24 000 caractères, soit 6 000 jetons) ne chevauche jamais deux feuilles.

## Alternatives écartées

- Donner à `processia_app` le droit de créer le schéma `pgboss` : élargit les droits du rôle applicatif pour un besoin d'installation.
- Une migration Drizzle qui installe le schéma pg-boss : couple nos migrations à la version interne de pg-boss.
- Réutiliser `mission_events` pour la progression : le serveur de coédition y lit une charge `{missionId, version}`.
- Considérer la capacité `documents` du fournisseur factice comme toujours présente : le critère « sans fournisseur doté de `documents` → non lisible » ne serait pas vérifiable et un scan passerait par une réponse générique.

## Conséquences

- Les tests d'intégration lancent le consommateur dans le processus de test (`startConsuming()`).
- WP-10 doit écouter `mission_messages` et relayer `RunProgressMessage` (`@processia/contracts`).
- Le dépôt se fait sur `model.edit`, la lecture sur `mission.read_workspace` : le validateur n'accède pas aux sources [PO-73].
- La mémoire d'un dépôt de 50 Mo est tenue en entier (multer en mémoire, puis tampon S3) : acceptable à cette échelle, à revoir si les limites montent.
