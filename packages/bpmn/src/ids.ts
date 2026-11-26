/** Identifiants BPMN dérivés des identifiants du modèle (spécification 6.1). */

export const PROCESSIA_NS = 'urn:processia:bpmn:1';
export const PROCESSIA_PREFIX = 'processia';

const UUID_COMPACT = /^[A-Za-z]+_([0-9a-f]{32})(?:_|$)/;

/** UUID sans tirets. */
export function compact(elementId: string): string {
  return elementId.replace(/-/g, '');
}

function expand(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `Activity_<uuid>`, `Lane_<uuid>_<ancre>`… ; `scope` désambiguïse les formes répétées d'un diagramme à l'autre. */
export function bpmnId(prefix: string, elementId: string, scope?: string): string {
  return scope === undefined
    ? `${prefix}_${compact(elementId)}`
    : `${prefix}_${compact(elementId)}_${scope}`;
}

/**
 * Premier identifiant d'élément contenu dans un identifiant BPMN, s'il y en a un.
 * Pour les formes dérivées (`Flow_<a>_<b>`), l'attribut `processia:elementId` fait foi.
 */
export function elementIdFromBpmnId(id: string): string | undefined {
  const m = UUID_COMPACT.exec(id);
  return m?.[1] === undefined ? undefined : expand(m[1]);
}

/** Clé d'un diagramme dans les identifiants BPMN (`L0`, ou l'UUID de l'ancre sans tirets). */
export function diagramKey(diagram: string): string {
  const sep = diagram.indexOf(':');
  return sep < 0 ? diagram : compact(diagram.slice(sep + 1));
}
