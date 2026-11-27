# Runbook : lancer, tester, réinitialiser

## Prérequis

- Node.js >= 22.12 (`.nvmrc` : 22) ; pnpm 10 via corepack (`corepack enable`) ; Docker avec Compose v2.

## Premier démarrage

```bash
corepack enable
pnpm install
cp .env.example .env        # valeurs de développement, aucun secret réel
pnpm services:up            # docker compose up -d --wait
pnpm build                  # nécessaire une fois pour `pnpm dev` et les builds des unités
pnpm dev                    # web :3000, API :3001, collab :3002
curl localhost:3001/health  # {"db":"ok","s3":"ok"}
```

## Services (docker compose)

| Service       | Port                          | Rôle                                                                                |
| ------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| postgres (17) | 5432                          | bases `processia` et `processia_test` (utilisateur et mot de passe `processia`)     |
| minio         | 9000 (S3), 9001 (console)     | buckets privés `processia-sources` et `processia-artifacts`, créés par `minio-init` |
| mailpit       | 1025 (SMTP), 8025 (interface) | boîte mail de développement                                                         |

- État : `docker compose ps` ; journaux : `docker compose logs -f <service>`.
- **Image MinIO** : les images officielles `minio/minio` ne sont plus sur Docker Hub. Par défaut, le fork `pgsty/minio` est utilisé. Pour l'image officielle : `MINIO_IMAGE=quay.io/minio/minio:latest pnpm services:up` (ou la mettre dans `.env`).
- **Profil `apps`** : `docker compose --profile apps up -d --wait --build` lance aussi api, collab et web en conteneurs de développement (`apps/*/Dockerfile.dev`, code copié dans l'image : reconstruire après une modification). Au quotidien, préférer `pnpm dev` sur l'hôte.
- Les scripts d'initialisation de postgres (`docker/postgres/`) ne s'exécutent qu'à la création du volume.

## Tests

```bash
pnpm lint && pnpm typecheck && pnpm test     # avant chaque fin de WP
pnpm services:up && pnpm test:int            # intégration (services requis)
pnpm e2e                                     # E2E : build web + API, base processia_test remise à l'état du seed, Playwright
```

**Navigateur Playwright.** En CI, `pnpm --filter @processia/e2e exec playwright install --with-deps chromium`. Dans un environnement où Chromium est déjà installé (cas des agents), ne pas lancer `playwright install` : définir `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium`. Les traces sont désactivées (`trace: 'off'`). Pour viser un serveur déjà lancé : `E2E_BASE_URL=http://localhost:3000` (la base de test n'est alors pas préparée). `pnpm e2e` démarre l'API sur `processia_test` (port 3001, qui doit être libre) et le web (port 3000) ; il n'utilise pas la base de développement. `E2E_SCREENSHOT=1 pnpm e2e` régénère `docs/wp/WP-07-dashboard.png` et `docs/wp/WP-13-analyse.png`. Le worker pg-boss (lecture des documents, extraction) est lancé par `e2e/global-setup.ts` sur la base de test ; `pnpm e2e` exige donc aussi que `apps/api` soit construit (c'est le cas).

## Comptes de développement et connexion locale

`pnpm db:migrate && pnpm db:seed` crée cinq comptes, tous avec le **mot de passe de développement** `Processia-dev-2026!` (valeur publique, réservée au développement local ; `db:seed` refuse de tourner en production) :

| Courriel                       | Rôle global            |
| ------------------------------ | ---------------------- |
| `admin@processia.local`        | administrateur         |
| `responsable@processia.local`  | responsable de mission |
| `consultante1@processia.local` | consultant             |
| `consultant2@processia.local`  | consultant             |
| `validateur@processia.local`   | validateur client      |

La double authentification est obligatoire et n'est pas pré-enrôlée : à la première connexion (`POST /auth/login`), l'API répond `mfa_enroll`. `POST /auth/mfa/enroll` renvoie le QR code et la clé de saisie manuelle ; `POST /auth/mfa/confirm` valide le premier code et renvoie les 10 codes de secours (affichés une seule fois). Sans application d'authentification, `pnpm --filter @processia/api build && pnpm --filter @processia/api dev:totp admin@processia.local` affiche le code courant d'un compte déjà enrôlé (développement uniquement).

- Le cookie de session `__Host-sid` est `Secure` : les navigateurs l'acceptent sur `http://localhost`, mais pas sur une autre adresse en HTTP. Avec `curl`, ajouter `-k` n'y change rien : lire `Set-Cookie` et renvoyer `Cookie` à la main, plus l'en-tête `x-csrf-token` (valeur `csrfToken` des réponses) sur chaque requête non GET.
- Un compte verrouillé (6 échecs) se débloque seul au bout de 15 minutes ; en développement : `UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE email = '...'`.
- Invitations : `POST /invitations` (administrateur) envoie un courriel visible dans Mailpit (http://localhost:8025) ; le lien est `WEB_ORIGIN/invitations/<jeton>` (72 h, usage unique), accepté par `POST /invitations/:token/accept`.
- L'API se connecte avec `DATABASE_APP_URL` (rôle `processia_app`, soumis à la RLS), plus avec `DATABASE_URL`.

## Worker et dépôt de documents (WP-11)

- `pnpm dev` lance l'API ; les tâches asynchrones (extraction de documents) ne sont consommées que par le worker : `pnpm --filter @processia/api dev:worker` (ou `start:worker` après `pnpm build`). Sans worker, un document déposé reste en statut `pending`.
- La file pg-boss vit dans le schéma `pgboss` de PostgreSQL ; elle est créée au premier démarrage avec le rôle propriétaire (ADR 0016).
- Dépôt : `POST /missions/:id/sources/documents` (multipart, champ `file`, 50 Mo, PDF, DOCX, XLSX, PNG, JPEG, TXT, MD). Progression : `GET /missions/:id/runs/:runId` ou le canal `mission_messages`.
- Les tests d'intégration des sources démarrent leur propre consommateur ; ils exigent PostgreSQL et MinIO (`pnpm services:up`).

## Analyse : extraction du pilote (WP-12)

- « Analyser » : `POST /missions/:id/analysis/extractions` (corps `{}` : fige la description, ou `{ "sourceId": "…" }` : source déjà lisible). Le job `analysis.extraction` est consommé par le worker ; suivi par `GET /missions/:id/runs/:runId`. Une seule extraction à la fois par mission (409).
- Sans clé IA, le fournisseur factice rejoue le **scénario du pilote** (`packages/test-fixtures/src/pilot.ts`) : collez `PILOT_DESCRIPTION` dans la description du métier pour obtenir les 14 macroprocessus, les 8 acteurs et les 4 parties prenantes du CDC 8. Un autre texte ne produit aucun candidat.
- Les tests d'acceptation sont dans `apps/api/src/analysis/extraction.int.test.ts` (`pnpm exec vitest run --config vitest.int.config.ts apps/api/src/analysis`).

## Questionnement guidé et hypothèses (WP-14)

- Routes (toutes sous `/missions/:id`) : `GET questions` ; `POST questions/generate` (pipeline `questions`), `questions/:questionId/answer` (corps `{ text }` : source `answer` puis `answer.integrate`), `questions/:questionId/skip`, `questions/stop` ; `POST hypotheses/generate`, `POST summary/generate` (`deliverable.summary`) ; `POST elements/:elementId/decision` (corps `{ decision: 'accept' }`, `{ decision: 'correct', correction }` ou `{ decision: 'reject', reason? }` ; 409 `ALREADY_DECIDED` si l'élément est déjà décidé).
- Les quatre genres d'exécution (`questions`, `hypotheses`, `summary`, `answer`) passent par la file pg-boss `analysis.guided`, donc par le worker ; suivi par `GET runs/:runId` ou `run.progress`. Une seule exécution de chaque genre à la fois (409 `GUIDED_IN_PROGRESS`).
- Avec le fournisseur factice, les scénarios du pilote (`packages/test-fixtures/src/pilot-guided.ts`) répondent : analysez `PILOT_DESCRIPTION`, générez les questions (la première est celle sur l'environnement du métier), puis répondez avec `PILOT_ANSWER_ENVIRONMENT`, `PILOT_ANSWER_SAISIE` ou `PILOT_ANSWER_IMPUTATION` pour obtenir des éléments cités ; les cinq hypothèses viennent de `PILOT_HYPOTHESES`.
- Tests d'acceptation : `apps/api/src/analysis/guided.int.test.ts` (`pnpm exec vitest run --config vitest.int.config.ts apps/api/src/analysis/guided.int.test.ts`) et `e2e/tests/z-questionnement.spec.ts` (`E2E_SCREENSHOT=1` régénère `docs/wp/WP-14-questionnement.png`).

## Livrables et exports (WP-15)

- Page `/missions/<id>/livrables` (lien « Voir les 4 livrables » de l'espace Analyse) : aperçu des 4 livrables et boutons d'export Word, PDF, Excel.
- Routes (sous `/missions/:id`) : `GET deliverables[?version=]` (aperçu, sans hypothèse) ; `GET exports` ; `POST exports` (corps `{ "format": "docx" | "pdf" | "xlsx" }`, tâche `export.create` du worker, suivi par `GET runs/:runId`) ; `GET exports/:artifactId/download-url` (URL présignée, 5 minutes). Le validateur reçoit 403.
- Le PDF est rendu par Chromium dans le **worker** : définir `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (ex. `/opt/pw-browsers/chromium`) ou installer le navigateur Playwright ; l'image `apps/api/Dockerfile.worker` l'embarque.
- Tests : `packages/exports/src/exports.test.ts` (unitaire : DOCX relu avec mammoth, XLSX avec exceljs), `packages/exports/src/pdf.int.test.ts` et `apps/api/src/exports/exports.int.test.ts` (Chromium et `pnpm services:up` requis), `e2e/tests/z-livrables.spec.ts`. `WP15_SAMPLES_DIR=<dossier>` écrit les échantillons ; `E2E_SCREENSHOT=1` régénère `docs/wp/WP-15-livrables.png`.

## Validation, commentaires et courriels (WP-16)

- Routes (sous `/missions/:id`) : `GET submissions`, `GET submissions/preview?kind=`, `POST submissions` (corps `{ "kind": "analysis_dossier", "comment": "…" }`), `GET submissions/:sid[/document|/elements]`, `POST submissions/:sid/{withdraw|replace|validate|exports}`, `GET submissions/:sid/exports/:artifactId/download-url`, `GET|POST comments`, `POST comments/:cid/resolve`, `GET notices`, `POST notices/seen` ; hors mission : `GET /notifications`, `POST /notifications/read`. Le validateur ne lit que la version figée de ses soumissions.
- `GET /missions/:id/mapping` répond `409 PHASE_LOCKED` tant que le dossier d'analyse n'est pas validé (`@RequiresPhase('mapping')`).
- Les courriels (soumission, validation, signalement après validation) partent du **worker** (boîte d'envoi relevée chaque seconde) : sans worker, ils restent en attente. Mailpit : http://localhost:8025.
- Tests d'intégration : `apps/api/src/validation/validation.int.test.ts` (worker dans le processus, Chromium, MinIO, Mailpit). Pour ne pas se heurter à d'autres sessions qui partagent PostgreSQL, créer une base dédiée (`CREATE DATABASE processia_x OWNER processia` et `GRANT CONNECT, TEMP ON DATABASE processia_x TO processia_owner, processia_app`) et pointer `DATABASE_TEST_URL` vers elle dans `.env` ; les E2E, eux, visent toujours `processia_test` (`e2e/test-env.ts`).

## Cartographie : enchaînements des processus (WP-17)

- Page `/missions/<id>/cartographie` (onglet « Cartographie ») : tant que le dossier d'analyse n'est pas validé (phase `analysis`), elle indique que la cartographie est verrouillée ; ensuite elle liste les 45 processus du pilote par macroprocessus, avec « Construire », « Détailler » (niveau 3 d'une tâche), « Tout confirmer » et « Tout écarter ».
- Routes (sous `/missions/:id/mapping`, toutes en `@RequiresPhase('mapping')` : 409 `PHASE_LOCKED` avant la validation, 403 pour le validateur) : `GET processes` (processus, état, dernier lot) ; `POST flows` (corps `{}` : tous les processus sans enchaînement ; `{ "processIds": [...] }` ; ou `{ "detailTaskIds": [...] }` pour le niveau 3) ; `POST processes/:processId/decision` (corps `{ "decision": "accept" | "reject", "taskId"? }`). Le lot est le job `analysis.flow` du worker (genre `process_flow`), suivi par `GET /missions/:id/runs/:runId` ou `run.progress` ; 409 `FLOW_IN_PROGRESS` (un lot à la fois) et `NOTHING_TO_BUILD`.
- Pour tester à la main : analyser `PILOT_DESCRIPTION`, soumettre le dossier (`POST submissions`, `{ "kind": "analysis_dossier" }`), le faire valider par `validateur@processia.local` (`POST submissions/:sid/validate`), puis `POST mapping/flows`. Le fournisseur factice répond avec `packages/test-fixtures/src/pilot-flow.ts` : environ 430 hypothèses pour les 45 processus ; « Relance des pièces manquantes » (processus « Relances clients », P04) se détaille avec `detailTaskIds`.
- Tests : `packages/ai/src/flow/flow.test.ts` (unitaire), `apps/api/src/mapping/flow.int.test.ts` (intégration : worker dans le processus, Chromium pour les exports joints à la soumission, MinIO, Mailpit), `e2e/tests/z-cartographie.spec.ts` (`E2E_SCREENSHOT=1` régénère `docs/wp/WP-17-cartographie.png`).

## Réinitialiser

```bash
pnpm db:reset      # docker compose down -v (supprime les volumes), relance, migre et sème
                   # (les volumes docker sont PARTAGÉS entre worktrees : ne pas l'utiliser en parallèle)
pnpm services:down # arrête sans supprimer les données
```

## Variables d'environnement

Le schéma de référence est `packages/config/src/env.ts` ; `.env.example` en donne les valeurs de développement. Les scripts `dev` et `start` des applications lisent `../../.env` s'il existe (`node --env-file-if-exists`). Une variable invalide ou manquante arrête le démarrage avec la liste des variables en cause. Toute nouvelle variable : schéma, `.env.example`, ce tableau.

| Variable                                                       | Rôle                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`, `DATABASE_TEST_URL`                            | PostgreSQL (base applicative, base de test)                                        |
| `S3_*`                                                         | stockage objet : point d'accès, identifiants, buckets                              |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`                          | courrier                                                                           |
| `WEB_PORT`, `API_PORT`, `COLLAB_PORT`, `API_URL`, `WEB_ORIGIN` | ports et URL des services                                                          |
| `COLLAB_PUBLIC_URL`                                            | URL WebSocket du serveur de coédition vue du navigateur (WP-10)                    |
| `SESSION_SECRET`, `COLLAB_JWT_SECRET`                          | secrets (32 caractères minimum), WP-05 et WP-10                                    |
| `MASTER_KEY`                                                   | clé de chiffrement des clés API des fournisseurs IA (32 caractères minimum), WP-06 |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY`                             | fournisseur IA (`fake` par défaut)                                                 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`                          | Chromium du rendu PDF du worker (optionnelle, WP-15)                               |
| `AI_PROVIDER_OVERRIDE`, `AI_RECORD`, `AI_RECORDINGS_DIR`       | force le factice ; mode enregistrement ; dossier des enregistrements (WP-09)       |
| `AI_PRICE_TABLE`, `AI_BASE_URL`                                | table de prix JSON (estimation du coût) ; URL de base du fournisseur (tests)       |

`POSTGRES_USER` et `POSTGRES_PASSWORD` ne servent qu'à docker compose.

## Dépannage

- `typecheck` signale un module `@processia/...` introuvable : lancer `pnpm build` (les `.d.ts` des paquets sont produits dans `dist/`). Turborepo le fait déjà via `^build`.
- Port 3000, 3001 ou 5432 occupé : arrêter l'autre processus ou changer le port dans `.env` et `docker-compose.yml`.
- `/health` renvoie 503 : le corps indique la dépendance en échec (`{"db":"ok","s3":"error"}`). Vérifier `docker compose ps`.
- Les workflows GitHub se valident avec `actionlint` (ou `docker run --rm -v "$PWD:/repo" --workdir /repo rhysd/actionlint:1.7.12`).
