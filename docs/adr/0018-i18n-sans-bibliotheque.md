# 0018. Internationalisation : fonction `t` typée, sans `next-intl`

- Statut : acceptée
- Date : 2026-11-27
- Références : spécification 7 (WP-07), ADR 0010 ; CLAUDE.md (« aucun texte en dur »)

## Contexte

La spécification de WP-07 cite `next-intl`, `fr.json` et des clés typées. L'ADR 0010 laissait ouverte l'adoption d'une bibliothèque. L'incrément 1 n'a qu'une langue (français) ; les textes sont lus à la fois par des composants serveur (métadonnées, titres de page), des composants client, `packages/ui` (qui ne dépend pas de Next) et l'API (courriel d'invitation, politique de données).

## Décision

On garde `@processia/i18n` tel que posé par WP-01 : un fichier `fr.json`, un type `MessageKey` calculé sur ses clés et une fonction `t(clé, valeurs)` qui remplace les paramètres `{nom}`. Aucune bibliothèque supplémentaire n'est ajoutée.

- Tous les textes d'interface, y compris les messages d'erreur (un message par code d'erreur de l'API, `errors.*`, table exhaustive `Record<ClientErrorCode, MessageKey>` dans `apps/web/src/lib/errors.ts`), vivent dans `fr.json`.
- Les dates et nombres passent par `Intl` avec la locale `fr-FR` (`apps/web/src/lib/format.ts`).
- Les règles ESLint `i18next/no-literal-string` (mode `jsx-only`) restent actives dans `apps/web` et `packages/ui`. Seuls les attributs techniques (`className`, `id`, `tone`, `role`, `variant`, `slot`, `href`, `name`, `type`, etc.) sont exclus de la règle (`packages/config/eslint/index.mjs`) ; les attributs de texte (`aria-label`, `placeholder`, `alt`, `title`, `label`, `description`) restent contrôlés.

## Alternatives écartées

- `next-intl` : apporte le routage par locale, un fournisseur de contexte et un chargement asynchrone des messages, inutiles avec une seule langue ; il lierait `packages/ui` et l'API à Next ou obligerait à dupliquer la couche de traduction.
- `i18next` / `react-i18next` : plus lourd, et son typage des clés demande une configuration supplémentaire pour un bénéfice nul ici.

## Conséquences

- Le français est la seule langue ; l'ajout d'une langue demandera de revoir cette décision (pluriels, sélection de la locale, chargement dynamique). Les pluriels sont aujourd'hui écrits « hypothèse(s) » ; une vraie gestion des pluriels ira avec cette révision.
- `t` s'appelle partout de la même façon (composants serveur, client, API, paquets), ce qui garde `packages/ui` indépendant de Next.
