import {
  FINDING_FAMILIES,
  diagramOfElement,
  type BusinessModel,
  type Finding,
  type FindingFamily,
} from '@processia/model';

/** Diagnostic de l'AS-IS (WP-21) : fonctions pures de la page. */

export type SeverityKey = 'low' | 'medium' | 'high';

export const severityKey = (severity: Finding['severity']): SeverityKey =>
  severity === 3 ? 'high' : severity === 2 ? 'medium' : 'low';

/** Nombre de constats affichés d'emblée par famille (les autres sont derrière « Afficher… »). */
export const FAMILY_PAGE_SIZE = 8;

/** Constats du modèle : gravité décroissante, puis code (`CST-2` avant `CST-10`). */
export function findingsOf(model: BusinessModel | null): Finding[] {
  if (model === null) return [];
  return Object.values(model.elements)
    .filter((e): e is Finding => e.kind === 'finding')
    .sort(
      (a, b) => b.severity - a.severity || a.code.localeCompare(b.code, 'fr', { numeric: true }),
    );
}

export interface FamilyGroup {
  family: FindingFamily;
  findings: Finding[];
}

/** Les quatre familles, dans l'ordre de la spécification, même vides. */
export function groupByFamily(findings: readonly Finding[]): FamilyGroup[] {
  return FINDING_FAMILIES.map((family) => ({
    family,
    findings: findings.filter((f) => f.family === family),
  }));
}

export interface DiagnosticCounts {
  total: number;
  /** À examiner : encore à l'état d'hypothèse. */
  pending: number;
  confirmed: number;
}

export function diagnosticCounts(findings: readonly Finding[]): DiagnosticCounts {
  const pending = findings.filter((f) => f.status.value === 'hypothesis').length;
  return { total: findings.length, pending, confirmed: findings.length - pending };
}

export interface FindingLocation {
  id: string;
  code: string;
  label: string;
  /** Le niveau de la cartographie qui montre l'élément ; `null` : non dessiné. */
  diagram: string | null;
  href: string;
}

/**
 * Éléments localisés par un constat, avec le lien qui les montre sur la cartographie. Les éléments
 * qui ne sont pas dessinés (flux d'information, objet de données) restent listés, sans lien utile.
 */
export function findingLocations(
  model: BusinessModel,
  missionId: string,
  finding: Finding,
): FindingLocation[] {
  return finding.location.flatMap((id) => {
    const element = model.elements[id];
    if (element === undefined) return [];
    return [
      {
        id,
        code: element.code,
        label: element.label,
        diagram: diagramOfElement(model, id) ?? null,
        href: `/missions/${missionId}/cartographie?element=${encodeURIComponent(id)}`,
      },
    ];
  });
}
