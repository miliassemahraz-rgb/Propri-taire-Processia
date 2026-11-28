import { z } from 'zod';

/** Contrats de la cartographie en lecture : BPMN d'un diagramme (WP-19). */

/** `?version=` : absent = version de tête. */
export const bpmnQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
});
export type BpmnQuery = z.infer<typeof bpmnQuerySchema>;

/** Identifiant de diagramme : `L0`, `L1:<id>`, `L2:<id>` ou `L3:<id>` (spécification 6.2). */
export const diagramIdParamSchema = z.string().regex(/^(?:L0|L[123]:[0-9a-fA-F-]{36})$/);

/** BPMN 2.0 d'un diagramme, tel que l'affiche la visionneuse. */
export interface BpmnDiagramDto {
  diagram: string;
  /** Version du modèle projetée (la tête si aucune version n'est demandée). */
  version: number;
  /** BPMN 2.0 XML avec son BPMN DI et l'extension `processia`. */
  xml: string;
}
