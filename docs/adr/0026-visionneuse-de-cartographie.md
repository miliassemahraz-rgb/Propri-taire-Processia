# 0026. Visionneuse de cartographie : trois vues sur un même plan structuré

- Statut : acceptée
- Date : 2026-11-27
- Références : spécification 6.2, 6.3 et section 7 (WP-19), CDC 2.3 et 4.1, ADR 0002, ADR 0013 (mise en page BPMN), ADR 0020 (document `model`), ADR 0025, [PO-160] à [PO-165]

## Contexte

La page Cartographie (WP-17) pilotait la construction des enchaînements mais ne montrait rien du résultat. WP-19 doit afficher les quatre niveaux (L0 à L3) en trois vues : BPMN complet (mode expert), vue simplifiée (mode simple, plus tard le validateur) et alternative textuelle (RGAA : un canevas BPMN n'est pas lisible par un lecteur d'écran). Les contraintes : le modèle JSON reste l'unique source de vérité (ADR 0002), les frontières de paquets (`apps/web` ne peut pas importer `@processia/bpmn` ni `@processia/ai`), la mise à jour en direct en moins de 2 s, et un test de cohérence entre la vue simplifiée, l'alternative textuelle et le BPMN.

## Décision

1. **Un plan structuré unique, dans `@processia/model`.** `buildOutline(model, diagram)` (`packages/model/src/ops/outline.ts`) projette un diagramme en étapes ordonnées (rang de lecture), groupes (un couloir par acteur, ou par catégorie au niveau 0), flux (avec condition et branche par défaut, ou déduits de l'ordre), et descente possible (`drillTo`). Avec `listDiagrams`, `parseDiagramId` et `diagramTrail` (fil d'Ariane L0 › L1 › L2 › L3), qui y ont été déplacés ; `@processia/bpmn` les réexporte. La vue simplifiée et l'alternative textuelle lisent ce seul plan : elles ne peuvent pas diverger entre elles.
2. **Cohérence avec le BPMN prouvée par un test.** `packages/bpmn/src/outline.test.ts` compare, pour chaque diagramme des trois jeux de test (minimal, complet, riche), les éléments du plan (activités, événements, passerelles) aux formes BPMN portant `processia:elementId`, et les flux de séquence du plan à ceux du BPMN. Une règle de projection modifiée d'un seul côté fait échouer le test. Un E2E refait la comparaison sur le pilote enchaîné (vue simplifiée, alternative textuelle, formes du canevas bpmn-js).
3. **Les vues lisent le modèle partagé.** Le web utilise `useMissionModel()` (document Yjs `model`, ADR 0020) : à chaque version enregistrée par n'importe quel consultant, la vue simplifiée et l'alternative textuelle se recalculent aussitôt ; la vue BPMN relit le XML (`version` du modèle en dépendance). Le cadrage du canevas est conservé quand le même niveau est relu.
4. **BPMN produit côté API.** `CartographyModule` expose `GET /missions/:id/bpmn/:diagramId?version=` (`@Can('mission.read_workspace')` puis `@RequiresPhase('mapping')`, 403 pour le validateur) et renvoie `{ diagram, version, xml }`. Le XML est calculé par `toBpmn` (WP-18) et gardé en mémoire par mission, version et diagramme (200 entrées au plus). `@processia/bpmn` n'est jamais importé côté navigateur ; le navigateur ne reçoit que le XML.
5. **Dispositions enregistrées par la lecture de la tête.** Quand `toBpmn` rend des positions nouvelles (`layoutOps`) pour la version de tête, `CartographyService` les enregistre une fois dans une version de cause `layout` (ChangeSet `set_layout`), sous un verrou par mission qui ne garde que les positions encore absentes, et seulement si le demandeur est membre (responsable ou consultant). Une version passée se lit sans rien écrire. Le rendu suivant réutilise ces positions : ajouter une tâche ne déplace pas les autres (stabilité, WP-18). La version de disposition relance une lecture du BPMN (même XML) : sans effet visible.
6. **Interface.** `bpmn-js` `NavigatedViewer` est chargé à la demande (`import()` dans un effet : jamais côté serveur), seulement dans la vue BPMN. Sélection au clic, descente au double-clic, par Entrée ou par le bouton du panneau [PO-160] ; le conteneur se parcourt aux flèches, Début, Fin. Les marqueurs sont posés sur les formes par `canvas.addMarker` (contour pointillé des hypothèses, CSS) et par des pastilles de texte (hypothèse, constat, écart) : jamais la couleur seule. La vue simplifiée est un composant React à coordonnées calculées (cartes et flèches SVG alignées, sans mesure du DOM) ; les flèches sont décoratives et chaque carte dit sa suite en texte.
7. **Rien d'éditable.** La visionneuse est en lecture seule (le module de modélisation n'est pas chargé) ; la modification passe par le dialogue (WP-20). Le panneau publie un commentaire interne (`comments`, `target_kind = element`, sans soumission) [PO-164].

## Alternatives écartées

- Déduire la vue simplifiée du XML BPMN côté navigateur : exige `bpmn-moddle` dans le web, couple la vue simple au format d'échange et fait lire un fichier de 450 Ko pour dessiner quelques cartes.
- Rendre le BPMN dans le navigateur (`@processia/bpmn` + elkjs) : interdit par la matrice des frontières, et une mise en page différente à chaque ouverture ruinerait la stabilité.
- Ne pas enregistrer les positions : un nouvel élément pourrait redisposer tout le diagramme, contre le critère de stabilité de WP-18.
- Descente au simple clic (spécification 6.3 à la lettre) : empêche de lire le panneau d'une tâche ou d'un processus sans changer de niveau [PO-160].
- Une route d'export du ZIP `bpmn.zip` : hors périmètre (WP-24).

## Conséquences

- `apps/api` dépend maintenant de `@processia/bpmn` (autorisé par `boundaries.mjs`) ; `apps/web` de `bpmn-js` (18.33.1, la version déjà testée par WP-18) et de ses feuilles de style.
- Chaque lecture d'un diagramme neuf peut ajouter une version « Disposition du diagramme … » à l'historique. Le retour arrière reste possible (il recopie aussi les positions).
- La page Cartographie a deux onglets : « Visionneuse » (par défaut) et « Enchaînements des processus » (WP-17, inchangé).
- Le composant `MappingViewer` ne dépend que du modèle et de l'identifiant de mission : le portail du validateur (WP-21) pourra l'embarquer en vue simplifiée sur une version figée, avec une route de lecture dédiée.
