# 0005. pg-boss pour la file de tâches, sans Redis

- Statut : acceptée (provisoire, révisable)
- Date : 2026-11-26
- Références : spec 1.1 ; [HORS-CDC]

## Contexte

Les pipelines IA, l'extraction de documents et les exports sont asynchrones. Le budget et la simplicité d'exploitation de l'incrément 1 plaident pour peu de composants.

## Décision

La file est **pg-boss**, adossée à PostgreSQL (schéma `pgboss`). Il n'y a pas de Redis. Le worker est un second point d'entrée de `apps/api` (`worker.ts`) qui partage les modules Nest. WP-01 ne crée que l'entrée vide ; la file est branchée en WP-11.

## Alternatives écartées

- BullMQ avec Redis : un service de plus à héberger, sans besoin de débit qui le justifie.
- Un troisième dépôt ou service pour le worker : base de code supplémentaire.

## Conséquences

- Les tâches bénéficient des transactions PostgreSQL et de la sauvegarde existante.
- Le débit est limité à celui de PostgreSQL, suffisant pour l'incrément 1.
- Un passage à un autre système resterait possible derrière l'interface `JobsModule`.
