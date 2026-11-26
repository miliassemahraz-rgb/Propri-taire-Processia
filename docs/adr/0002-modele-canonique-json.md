# 0002. Modèle métier JSON canonique, BPMN en projection

- Statut : acceptée (provisoire, révisable)
- Date : 2026-11-26
- Références : spec 2, 6.1 ; [PO-1] ; CDC 4.1

## Contexte

Le CDC 4.1 dit que le modèle est stocké en BPMN 2.0. Le modèle de Processia doit porter la provenance, les statuts (extrait, hypothèse, confirmé, validé), les données et les règles, que le BPMN ne représente pas sans extensions lourdes.

## Décision

Le **modèle métier JSON** (`BusinessModel`, schémas zod dans `packages/model`) est l'unique source de vérité. Le **BPMN 2.0** est produit de façon déterministe à chaque version par `packages/bpmn`, stocké comme artefact et exportable. Les identifiants BPMN dérivent des `ElementId` et un attribut d'extension `processia:elementId` garantit la correspondance exacte. Décision provisoire, à valider par le PO.

## Alternatives écartées

- Stocker le BPMN comme modèle : dédouble la source de vérité et impose des extensions pour la provenance et les statuts.
- Deux modèles synchronisés : risque permanent de divergence.

## Conséquences

- Les projections (BPMN, livrables, exports) sont testables comme des fonctions pures.
- `packages/model` devient le contrat avec l'incrément 2 : toute évolution du schéma s'accompagne d'une migration de données.
- Si le PO refuse [PO-1], la section 6 et WP-18 sont à reprendre.
