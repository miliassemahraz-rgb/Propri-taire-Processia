# 0012. Mise en page BPMN : elkjs pour les colonnes, placement par couloir maison

- Statut : acceptée
- Date : 2026-11-26
- Références : spécification 6.2 ; ADR 0009 ; risque R-4 ; WP-18

## Contexte

L'ADR 0009 retient elkjs (algorithme en couches, « partitions par couloir »). Le spike d'ouverture de WP-18 a montré que les partitions d'ELK (`partitioning.partition`) ordonnent les noeuds le long de l'axe des couches : elles ne produisent pas de couloirs, c'est-à-dire de bandes qui découpent l'axe perpendiculaire. Une mise en page hiérarchique (bassin, couloirs en noeuds composés) place les couloirs comme des noeuds ordinaires d'un graphe en couches, pas comme des bandes empilées.

## Décision

`packages/bpmn/src/layout.ts` combine les deux :

1. **elkjs** (`layered`, direction `RIGHT`) sur le graphe plat des noeuds de flux, avec des tailles uniformes, ne sert qu'à obtenir les **colonnes** (une abscisse par couche) et l'ordre vertical dans une couche. Les flux nés d'un événement de bord comptent comme des flux de leur tâche hôte. Les noeuds sans lien sont répartis en lignes de 5 colonnes.
2. Le **placement par couloir** est fait par le code : une bande horizontale par acteur (niveaux 1 et 2), par catégorie de macroprocessus (niveau 0, dessinée en `group`) ou une bande unique (niveau 3) ; dans une bande, les noeuds d'une même colonne sont empilés et centrés. Les objets de données et les annotations sont des « satellites » empilés sous leur tâche. Les événements de bord sont posés sur le bord inférieur de leur hôte.
3. Les **liens** sont tracés par un routage orthogonal simple (3 segments, contournement par le bas pour les retours). Les liens peuvent traverser des formes : aucun test ne l'interdit (la spécification exige seulement l'absence de recouvrement de formes).
4. **Stabilité** : les positions mémorisées (`BusinessModel.layout`, clé = identifiant d'élément, y compris les couloirs d'acteur) sont réutilisées telles quelles ; un élément nouveau est placé près de son prédécesseur dans sa bande, au premier emplacement libre. Les couloirs mémorisés gardent leur ordonnée et leur hauteur ; un couloir nouveau est ajouté en bas. `toBpmn` renvoie les opérations `set_layout` des seules positions nouvelles ou changées.

`bpmn-auto-layout` n'est pas utilisé : la solution maison couvre aussi les niveaux 0 et 1, avec le même code.

## Alternatives écartées

- ELK hiérarchique avec couloirs en noeuds composés : voir le contexte.
- ELK pour le routage des liens après placement des noeuds (mode interactif) : sensible aux positions de départ, résultat peu prévisible ; le routage maison suffit pour la taille d'un processus (10 à 30 formes).
- `bpmn-auto-layout` : pas de couloirs.

## Conséquences

- La lisibilité dépend du routage simple : les flux de message traversent les couloirs, les libellés de deux événements de bord voisins peuvent se chevaucher. Amélioration possible plus tard (ports ELK, ancrage des messages sur le bord du bassin) sans changer le contrat.
- Les formes d'un diagramme sont stables tant que les positions mémorisées sont rejouées (critère 3 : 0 forme déplacée sur 23 en ajoutant une tâche, contre 21 sans mémorisation).
- Le placement dépend de l'ordre des éléments : tout est trié par code puis identifiant pour rester déterministe.
