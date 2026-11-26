# CLAUDE.md : consignes pour les agents de développement de Processia

Processia analyse et cartographie les processus métier d'un client à partir de textes, de dialogues et de documents. Le produit est écrit en TypeScript (monorepo pnpm). Ce dépôt est la **seule mémoire** entre les sessions de développement : lis-le avant d'agir, mets-le à jour avant de terminer.

## Protocole obligatoire (spécification 1.5)

1. Lire, dans cet ordre :
   1. ce fichier ;
   2. `docs/wp/TRACKER.md` (état de chaque WP) ;
   3. la fiche de ton WP dans `docs/specs/increment-1.md`, section 7, ainsi que les sections de la spécification qu'elle cite ;
   4. les rapports `docs/wp/WP-XX.md` des WP dont ton WP dépend ;
   5. les ADR cités (`docs/adr/`), `docs/dev/CONVENTIONS.md` et `docs/dev/RUNBOOK.md`.
2. **Ne pas élargir le périmètre du WP.** Toute découverte qui le dépasse est notée dans le rapport du WP, rubrique « Suite ».
3. Toute décision technique structurante devient un ADR (copier `docs/adr/0000-template.md`). Toute question de produit est ajoutée à `docs/po/DECISIONS.md` avec le statut `ouverte` ; applique la valeur par défaut documentée.
4. Avant de terminer, `pnpm lint && pnpm typecheck && pnpm test` sont verts, ainsi que les tests d'acceptation du WP. Mettre à jour `docs/wp/TRACKER.md` et écrire `docs/wp/WP-XX.md` (fait, écarts, dettes, suite).
5. Branches et commits : suivre les instructions de l'orchestrateur (branche `wp/WP-XX-slug`). Le dépôt n'a pas encore de dépôt distant : ne pas pousser tant que le PO ne l'a pas créé [PO-16].

## Documents de référence

| Fichier                                          | Rôle                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `docs/cahier-des-charges.md`                     | CDC : exigences. Lecture seule, sauf demande du PO                                      |
| `docs/specs/increment-1.md`                      | Spécification technique et plan des 26 WP. À mettre à jour quand une décision PO change |
| `docs/wp/TRACKER.md`                             | Statut des WP                                                                           |
| `docs/po/DECISIONS.md`                           | Décisions [PO-n] et valeurs par défaut appliquées                                       |
| `docs/adr/`                                      | Décisions techniques (une par fichier)                                                  |
| `docs/dev/CONVENTIONS.md`, `docs/dev/RUNBOOK.md` | Conventions de code ; lancer, tester, réinitialiser                                     |

## Règles non négociables

- **Le modèle métier JSON (`packages/model`) est l'unique source de vérité.** BPMN, livrables et exports en sont des projections déterministes (ADR 0002).
- **Aucune sortie de l'IA ne modifie le modèle sans décision humaine** : éléments `extracted` / `hypothesis`, ou proposition (ChangeSet) appliquée explicitement.
- **Tout est versionné** ; un retour arrière crée une nouvelle version.
- **Cloisonnement des missions** dans l'application et par RLS PostgreSQL (ADR 0003).
- **Interface en français, aucun texte en dur** : les textes passent par `@processia/i18n` (`i18next/no-literal-string` actif dans `apps/web` et `packages/ui`). Le code (identifiants, énumérations) est en anglais ; voir le glossaire FR ↔ code (spécification 0.4).
- **Accessibilité (RGAA)** : toute page nouvelle est couverte par un test axe-core sans violation `serious` ou `critical`.
- **Frontières entre paquets** : dépendances strictement descendantes, imposées par ESLint (`packages/config/eslint/boundaries.mjs`). `@processia/ai` n'est jamais importé côté navigateur.
- **Fournisseur IA factice par défaut** ; aucun appel réel sans clé configurée. N'écrire aucun identifiant de modèle IA en dur dans le code : il vient de la configuration.
- **Secrets** : jamais de vrai secret ni de `.env` dans git. `.env.example` ne contient que des valeurs de développement.

## Commandes

```bash
pnpm install              # installe (pnpm 10 via corepack ; Node >= 22.12)
pnpm lint                 # ESLint (frontières, i18n, a11y) + Prettier --check
pnpm format               # Prettier --write
pnpm typecheck            # tsc sur chaque unité (construit d'abord les paquets dont elle dépend)
pnpm test                 # Vitest à la racine (tests unitaires, sans service externe)
pnpm test:int             # tests d'intégration (*.int.test.ts) : exige `pnpm services:up`
pnpm build                # Turborepo : paquets, API, collab, web
pnpm e2e                  # build du web puis Playwright (voir le RUNBOOK pour le navigateur)
pnpm dev                  # tous les `dev` (web 3000, API 3001, collab 3002)
pnpm services:up|down     # docker compose : postgres, minio, mailpit
pnpm db:migrate           # migrations (squelette jusqu'à WP-04)
pnpm db:reset             # détruit les volumes, relance les services, migre
```

Un seul fichier de test : `pnpm exec vitest run chemin/du/fichier.test.ts`.

## Structure

`apps/web` (Next.js), `apps/api` (NestJS : `main.ts` HTTP, `worker.ts` tâches), `apps/collab` (Hocuspocus), `packages/*` (config, model, policy, contracts, db, ai, ingest, bpmn, diagnostic, exports, i18n, ui, test-fixtures), `e2e/` (Playwright). Détails et dépendances autorisées : spécification 1.2.

## Pièges connus

- Imports relatifs avec l'extension `.js` (ESM `NodeNext`) dans tous les paquets et dans `apps/api` et `apps/collab` ; `apps/web` utilise la résolution `Bundler`.
- `apps/api` : garder des imports de valeur (pas `import type`) pour les classes injectées par Nest, et utiliser `@Inject(...)`. Vitest (esbuild) n'émet pas les métadonnées de décorateurs.
- Un sous-chemin d'export d'un paquet (ex. `@processia/config/env`) doit être ajouté à l'alias de `vitest.config.ts`.
- Ne jamais lancer `playwright install` dans l'environnement des agents ; voir le RUNBOOK.
