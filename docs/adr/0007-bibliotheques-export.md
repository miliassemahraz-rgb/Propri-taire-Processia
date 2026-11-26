# 0007. Bibliothèques d'export (Word, PDF, Excel, BPMN, images)

- Statut : acceptée (provisoire, révisable)
- Date : 2026-11-26
- Références : spec 6.4 ; [HORS-CDC pour les bibliothèques]

## Contexte

Le CDC exige des exports Word, PDF, Excel et BPMN (CDC 3.5, 4.8) mais ne fixe aucune bibliothèque. Les exports sont des projections déterministes du modèle, sans hypothèses.

## Décision

- **Word** : `docx` (MIT).
- **Excel** : `exceljs` (MIT).
- **PDF** : gabarits HTML rendus côté serveur avec React et imprimés par Playwright / Chromium (`page.pdf`, PDF balisé).
- **BPMN** : `bpmn-moddle`, un fichier `.bpmn` par diagramme et un fichier combiné dans un ZIP.
- **Images de diagrammes** : `bpmn-js` dans Chromium headless (`saveSVG`), puis `@resvg/resvg-js` pour le PNG.
- L'image du worker embarque Chromium, déjà nécessaire pour les tests E2E.
- Le paquet `packages/exports` reste extensible par format (PowerPoint prévu à l'incrément 4). Ces bibliothèques sont installées dans les WP d'export, pas en WP-01.

## Alternatives écartées

- Génération Word/PDF par un service externe : données client hors périmètre.
- Bibliothèques PDF programmatiques : mise en page et accessibilité plus coûteuses que HTML imprimé.

## Conséquences

- Le PDF est balisé par Chromium mais non certifié PDF/UA ; un audit RGAA complet est prévu à l'incrément 5 (risque R-8).
- Les textes des exports proviennent du catalogue i18n.
- Les exports passent toujours par `deliverableView`.
