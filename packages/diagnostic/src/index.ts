/**
 * @processia/diagnostic : détecteurs déterministes du diagnostic (WP-21, spécification 4.4) et
 * construction du ChangeSet `diagnostic`. Le calcul des gains et le catalogue de ratios arrivent
 * avec WP-22. Paquet pur : pas d'entrée/sortie, pas d'horloge implicite.
 */
export const PACKAGE_NAME = '@processia/diagnostic' as const;

export * from './types.js';
export * from './detectors.js';
export * from './build.js';
