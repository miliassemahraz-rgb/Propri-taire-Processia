# 0001. Monorepo pnpm, Turborepo, TypeScript strict, Node.js

- Statut : acceptée (provisoire, révisable)
- Date : 2026-11-26
- Références : spec 1.2, 7 (WP-01) ; [HORS-CDC]

## Contexte

Le CDC ne fixe ni l'organisation du code ni la chaîne d'outils. Le produit comprend trois processus (web, API avec worker, collaboration) et une douzaine de bibliothèques qui partagent le méta-modèle. Les agents de développement travaillent en sessions successives et ont besoin d'un dépôt unique et uniforme.

## Décision

- Un seul dépôt, en **pnpm workspaces** (`apps/*`, `packages/*`, `e2e`) orchestré par **Turborepo** (`build`, `typecheck`, `dev`).
- **TypeScript `strict`** partout (`noUncheckedIndexedAccess`, `noImplicitOverride`), configuré dans `packages/config`.
- **ESM partout** (`"type": "module"`, `module: NodeNext`) : les imports relatifs portent l'extension `.js`. Les paquets compilent vers `dist/` avec `tsc` ; les autres unités les consomment par `exports`.
- **Vitest** à la racine : un alias renvoie chaque `@processia/*` vers son code source, les tests n'exigent donc pas de build préalable.
- **Frontières entre paquets** imposées par ESLint (`no-restricted-imports` généré depuis `packages/config/eslint/boundaries.mjs`), pas par `eslint-plugin-boundaries` : la règle ne dépend d'aucune résolution de modules, donc fonctionne sans build et sans résolveur TypeScript.
- **Node.js** : la spécification mentionne Node 24 LTS. WP-01 a été réalisé et validé sous Node 22 (`engines >=22.12`, `.nvmrc` = 22). Le passage à Node 24 est un changement de `.nvmrc`, des Dockerfiles et de `engines`, à faire quand l'environnement des agents le permet.
- **Images de services** : les images officielles `minio/minio` ne sont plus publiées sur Docker Hub ; `docker-compose.yml` utilise par défaut le fork communautaire `pgsty/minio` (variable `MINIO_IMAGE` pour viser `quay.io/minio/minio`).

## Alternatives écartées

- npm ou yarn workspaces : pnpm offre un magasin strict et rapide, adapté aux nombreux paquets.
- Nx : plus lourd que le besoin ; Turborepo suffit.
- Plusieurs dépôts : multiplierait la synchronisation du méta-modèle, contrat commun avec l'incrément 2.
- Paquets consommés directement en TypeScript source (sans `dist`) : impraticable pour NestJS (métadonnées de décorateurs, exécution Node).

## Conséquences

- Un `pnpm build` préalable alimente le typecheck des unités qui dépendent des paquets (`typecheck` dépend de `^build` dans Turborepo).
- Tout import d'un autre paquet passe par `@processia/<nom>` ; un sous-chemin d'export (par exemple `@processia/config/env`) doit aussi figurer dans l'alias de `vitest.config.ts`.
- ESLint 9 est conservé (le greffon `eslint-plugin-i18next` ne déclare pas encore ESLint 10).
