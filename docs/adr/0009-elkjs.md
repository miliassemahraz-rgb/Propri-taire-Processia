# 0009. elkjs pour la mise en page BPMN

- Statut : acceptée (provisoire, révisable)
- Date : 2026-11-26
- Références : spec 6.2 ; [HORS-CDC] ; risque R-4

## Contexte

Le BPMN produit par `packages/bpmn` doit contenir une mise en page (BPMN DI) lisible, avec couloirs, et stable d'une version à l'autre. Aucun éditeur graphique n'est prévu à l'incrément 1.

## Décision

La mise en page utilise **elkjs** (algorithme en couches, partitions par couloir), traduite en BPMN DI. Les positions sont mémorisées dans `BusinessModel.layout` (opérations `set_layout`, sans effet sur les statuts) ; un nouveau rendu réutilise les positions des éléments inchangés. `bpmn-auto-layout` ne sert que de repli pour les niveaux 0 et 1, car il ne gère pas les couloirs. Un spike ouvre WP-18.

## Alternatives écartées

- `bpmn-auto-layout` seul : pas de couloirs.
- Mise en page manuelle dans un éditeur : exclue de l'incrément 1.
- Graphviz : sortie à reconvertir, sans notion de couloir BPMN.

## Conséquences

- Risque R-4 (couloirs illisibles) suivi en WP-18, avec un repli documenté.
- Les diagrammes restent stables entre versions grâce aux positions mémorisées.
