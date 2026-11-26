/** @processia/ingest : détection du type, extraction de texte et découpage avec localisateurs (WP-11). */
export const PACKAGE_NAME = '@processia/ingest' as const;

export * from './types.js';
export * from './detect.js';
export * from './extract.js';
export * from './chunk.js';
export * from './visual.js';
export * from './paragraphs.js';
