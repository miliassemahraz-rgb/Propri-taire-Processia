import { z } from 'zod';

/** Contrats des livrables de l'étape 1 et des exports du dossier d'analyse (WP-15). */

export const EXPORT_FORMATS = ['docx', 'pdf', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Finalité (`artifacts.purpose`) des exports du dossier d'analyse ; `kind` est le format. */
export const DOSSIER_PURPOSE = 'analysis_dossier';
/** Finalité des exports joints à une soumission de validation : version figée (WP-16). */
export const SUBMISSION_PURPOSE = 'submission';
/** Type d'exécution (`analysis_runs.kind`) d'un export. */
export const EXPORT_RUN_KIND = 'export';

export const startExportSchema = z.object({ format: z.enum(EXPORT_FORMATS) });
export type StartExportRequest = z.infer<typeof startExportSchema>;

export interface StartExportResult {
  runId: string;
  /** Version du modèle figée pour cet export. */
  modelVersion: number;
}

/** Artefact d'export : lié à une version du modèle, avec son empreinte sha256. */
export interface ExportArtifactDto {
  id: string;
  format: ExportFormat;
  modelVersion: number;
  sha256: string;
  filename: string;
  createdAt: string;
  createdBy: string | null;
}

/**
 * Tableau d'un livrable. Les adaptateurs (aperçu web, Word, PDF, Excel) le restituent tel quel :
 * les textes sont déjà issus du catalogue i18n. `rowHeader` : la première colonne porte l'en-tête
 * de chaque ligne (matrice RACI accessible : `<th scope="row">`).
 */
export interface DocTable {
  id: string;
  caption: string;
  columns: string[];
  rows: string[][];
  rowHeader: boolean;
  /** Nom de la feuille Excel (31 caractères au plus, unique dans le dossier). */
  sheet: string;
  /** Texte affiché à la place du tableau quand il n'a aucune ligne. */
  empty: string;
}

export type DocBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'note'; text: string }
  | { type: 'table'; table: DocTable };

export interface DocSection {
  id: string;
  title: string;
  blocks: DocBlock[];
}

export interface DocCoverEntry {
  label: string;
  value: string;
}

/** Contenu du dossier d'analyse : 4 livrables et annexe, sans hypothèse (CDC 3.4). */
export interface DossierDocument {
  title: string;
  subtitle: string;
  language: 'fr';
  cover: DocCoverEntry[];
  /** Mentions placées après la page de garde (statuts, absence d'hypothèse). */
  notices: string[];
  deliverables: DocSection[];
  annex: DocSection;
  /** Version du modèle projetée. */
  modelVersion: number;
}

/** Aperçu HTML des livrables (page « Livrables ») : le document de la version demandée. */
export interface DeliverablesPreviewDto {
  version: number;
  document: DossierDocument;
}
