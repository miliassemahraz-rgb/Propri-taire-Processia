# 0023. Moteur d'exports du dossier d'analyse

- Statut : acceptée
- Date : 2026-11-27
- Références : spécification 6.4, WP-15, ADR 0007, ADR 0016, [PO-130] à [PO-135]

## Contexte

WP-15 produit les quatre livrables de l'étape 1 (CDC 3.5) en aperçu HTML et en Word, PDF et Excel. Il faut un seul contenu pour quatre restitutions, des fichiers liés à une version et vérifiables, et une frontière de paquets qui permette à l'interface de ne pas dupliquer la logique.

## Décision

1. **Un document neutre** (`DossierDocument`, types dans `@processia/contracts`) construit par `buildDossier` à partir de `deliverableView` et du catalogue i18n : sections, tableaux (`columns`, `rows`, `rowHeader`, nom de feuille), notes. Fonction pure, sans horloge ; aucune hypothèse n'y entre (point d'entrée unique). Les éléments « Extrait » restent, avec statut et source [PO-11] ; une source citée seulement par des hypothèses n'apparaît pas.
2. **Un adaptateur par format** : DOCX (`docx`), XLSX (`exceljs`, une feuille par tableau, feuilles vides conservées), PDF (gabarit React rendu en HTML, imprimé par Chromium via `playwright-core` : signets `outline`, PDF balisé `tagged`, JavaScript désactivé).
3. **Frontière** : `packages/exports` peut importer `@processia/contracts` (types seulement). L'aperçu web consomme le même document par `GET /missions/:id/deliverables` ; `apps/web` n'importe pas `exports`.
4. **Octets déterministes pour DOCX et XLSX** : dates du paquet fixées à la date de la version du modèle, archive réécrite (ordre trié, date fixe, sans entrées de dossier). Le PDF contient la date de création et un identifiant de Chromium : son texte est identique, pas ses octets.
5. **Tâche asynchrone** `export.create` (file pg-boss) : la version de tête est figée à la demande, l'artefact est écrit dans le bucket `artifacts` (`missions/<mission>/exports/<id>/<fichier>`), puis la ligne `artifacts` (`kind` = format, `purpose` = `analysis_dossier`, `model_version`, `sha256`). Téléchargement par URL présignée de 5 minutes. Suivi par `run.progress` (kind `export`).
6. **Droits** : aperçu, liste et téléchargement exigent `mission.read_workspace` ; la création exige `export.create` et refuse le validateur (son accès aux exports de ses soumissions est à WP-16).
7. **Chromium** : `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (optionnelle) ; image du worker `apps/api/Dockerfile.worker`.

## Alternatives écartées

- Générer chaque format directement depuis le modèle : quatre logiques à garder cohérentes.
- Rendre l'aperçu web par le gabarit du PDF : styles et accessibilité différents (React Aria, thème).
- Bibliothèque PDF programmatique : ADR 0007.

## Conséquences

- Le rapport de mission et le BPMN (WP-24) ajoutent des sections et des adaptateurs au même cadre.
- Le DOCX n'a pas de table des matières à champ (mise à jour manuelle sous Word) ; la navigation passe par les styles de titre.
