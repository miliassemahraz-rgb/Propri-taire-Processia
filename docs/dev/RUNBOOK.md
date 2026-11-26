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
pnpm e2e                                     # E2E de fumée : build du web, démarrage, Playwright
```

**Navigateur Playwright.** En CI, `pnpm --filter @processia/e2e exec playwright install --with-deps chromium`. Dans un environnement où Chromium est déjà installé (cas des agents), ne pas lancer `playwright install` : définir `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium`. Les traces sont désactivées (`trace: 'off'`). Pour viser un serveur déjà lancé : `E2E_BASE_URL=http://localhost:3000`.

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
| `SESSION_SECRET`, `COLLAB_JWT_SECRET`                          | secrets (32 caractères minimum), WP-05 et WP-10                                    |
| `MASTER_KEY`                                                   | clé de chiffrement des clés API des fournisseurs IA (32 caractères minimum), WP-06 |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY`                             | fournisseur IA (`fake` par défaut)                                                 |
| `AI_PROVIDER_OVERRIDE`, `AI_RECORD`, `AI_RECORDINGS_DIR`       | force le factice ; mode enregistrement ; dossier des enregistrements (WP-09)       |
| `AI_PRICE_TABLE`, `AI_BASE_URL`                                | table de prix JSON (estimation du coût) ; URL de base du fournisseur (tests)       |

`POSTGRES_USER` et `POSTGRES_PASSWORD` ne servent qu'à docker compose.

## Dépannage

- `typecheck` signale un module `@processia/...` introuvable : lancer `pnpm build` (les `.d.ts` des paquets sont produits dans `dist/`). Turborepo le fait déjà via `^build`.
- Port 3000, 3001 ou 5432 occupé : arrêter l'autre processus ou changer le port dans `.env` et `docker-compose.yml`.
- `/health` renvoie 503 : le corps indique la dépendance en échec (`{"db":"ok","s3":"error"}`). Vérifier `docker compose ps`.
- Les workflows GitHub se valident avec `actionlint` (ou `docker run --rm -v "$PWD:/repo" --workdir /repo rhysd/actionlint:1.7.12`).
