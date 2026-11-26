# Conventions de développement

## Langue

- **Code** (identifiants, énumérations, noms de fichiers) : anglais, selon le glossaire de la spécification 0.4.
- **Interface, documentation, commentaires, messages de commit** : français.
- Aucun texte d'interface en dur : `import { t } from '@processia/i18n'` puis `t('home.title')`. Les messages vivent dans `packages/i18n/src/messages/fr.json` ; le type `MessageKey` interdit une clé inconnue. Les paramètres s'écrivent `{nom}`.

## TypeScript

- `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns` (voir `packages/config/tsconfig/`).
- ESM : imports relatifs avec extension `.js` (`import { x } from './x.js'`). Exception : `apps/web` (Next.js, résolution `Bundler`).
- `import type` / imports `type` en ligne pour les types (règle `consistent-type-imports`), sauf dans `apps/api` (injection Nest).
- Pas de `any` ; pas de `console.log` hors `main.ts`, `worker.ts` et scripts (`console.info`, `warn`, `error` autorisés).
- Variables d'environnement : uniquement via `loadEnv()` de `@processia/config/env`. Toute nouvelle variable est ajoutée au schéma zod **et** à `.env.example`.
- Les paquets `model`, `policy`, `diagnostic`, `bpmn` sont purs : pas d'entrée/sortie, pas d'horloge ni d'aléa implicites (les passer en paramètre).

## Frontières entre paquets

La matrice autorisée est dans `packages/config/eslint/boundaries.mjs` et suit la spécification 1.2. Une importation interdite fait échouer `pnpm lint`. Pour autoriser une nouvelle dépendance : modifier la matrice, la déclarer dans le `package.json` (`workspace:*`), et noter la raison dans le rapport du WP (ou un ADR si elle change l'architecture). Ne jamais importer par chemin relatif d'un paquet à l'autre.

## Tests

- **Unitaires** : `src/**/*.test.ts(x)` à côté du code, Vitest à la racine, sans service externe ni build préalable. Les autres paquets sont importés depuis leur code source (alias).
- **Intégration** : `src/**/*.int.test.ts`, lancés par `pnpm test:int` (services docker requis ; variables lues dans `.env`, à défaut `.env.example`). Base dédiée : `processia_test`.
- **E2E** : `e2e/tests/*.spec.ts` (Playwright). Toute page nouvelle a un test axe-core (`@axe-core/playwright`, aucune violation `serious` ou `critical`).
- Les tests sont déterministes : fournisseur IA factice, horloge et identifiants injectés.
- Un test d'acceptation de WP porte le nom du critère de la spécification.

## Accessibilité (RGAA)

HTML sémantique, `lang="fr"`, un seul `h1` par page, navigation au clavier, contrastes AA, lien d'évitement (WP-07). `eslint-plugin-jsx-a11y` est actif sur `apps/web` et `packages/ui`.

## Git

- Branche par WP : `wp/WP-XX-slug` (instructions de l'orchestrateur ; WP-01 a été fait directement sur `main`).
- Commits en français, à l'impératif, préfixés par le type : `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`. Le corps explique le pourquoi.
- Jamais de secret, de `.env` ni de fichier généré (`dist`, `.next`, `.turbo`) dans git.
- Pas de dépôt distant pour l'instant [PO-16] : ne pas pousser.

## Documentation

Chaque WP termine par `docs/wp/WP-XX.md` (fait, écarts, dettes, suite) et la mise à jour de `docs/wp/TRACKER.md`. Les décisions techniques structurantes sont des ADR ; les questions de produit vont dans `docs/po/DECISIONS.md`.
