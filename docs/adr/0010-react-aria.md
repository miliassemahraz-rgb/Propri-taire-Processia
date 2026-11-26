# 0010. React Aria Components pour les composants accessibles

- Statut : acceptée (provisoire, révisable)
- Date : 2026-11-26
- Références : spec 1.2, 7 (WP-07) ; [HORS-CDC] ; CDC (RGAA)

## Contexte

L'interface doit respecter le RGAA dès le premier écran, en français, avec des composants accessibles au clavier et aux lecteurs d'écran (boutons, champs, dialogues, onglets, tableaux, toasts).

## Décision

`packages/ui` s'appuie sur **React Aria Components** (Adobe) avec un thème maison aux contrastes AA. Les textes passent par `packages/i18n` : la règle `i18next/no-literal-string` est active dans `apps/web` et `packages/ui`, `eslint-plugin-jsx-a11y` aussi, et chaque page est couverte par un test axe-core (aucune violation `serious` ou `critical`). WP-01 pose ces garde-fous (ESLint, test de fumée axe-core) ; les composants arrivent avec WP-07. Le paquet `i18n` fournit pour l'instant une fonction `t` typée sur les clés de `fr.json`, sans bibliothèque ; l'adoption d'une bibliothèque (next-intl par exemple) reste ouverte pour WP-07.

## Alternatives écartées

- Radix UI / shadcn : bonne base mais la conformité RGAA demande plus de travail de notre côté.
- Composants maison : coût et risque d'accessibilité.
- Bibliothèque graphique complète (MUI, Ant) : thème et accessibilité moins maîtrisés.

## Conséquences

- Un canevas BPMN n'est pas accessible aux lecteurs d'écran : une alternative textuelle est obligatoire pour chaque diagramme.
- Un audit RGAA complet reste prévu à l'incrément 5.
