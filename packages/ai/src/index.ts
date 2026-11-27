/** @processia/ai : interface fournisseur, fournisseur factice, adaptateur Anthropic, exécuteur (WP-09). */
export const PACKAGE_NAME = '@processia/ai' as const;

export * from './types.js';
export * from './errors.js';
export * from './hash.js';
export * from './pricing.js';
export * from './prompts.js';
export * from './guard.js';
export * from './fake-provider.js';
export * from './anthropic-provider.js';
export * from './runner.js';
export * from './pipelines/demo.js';
export * from './pipelines/document-visual.js';
export * from './pipelines/extraction.js';
export * from './extraction/text.js';
export * from './extraction/candidates.js';
export * from './extraction/changeset.js';
export * from './extraction/plan.js';
export * from './pipelines/guided.js';
export * from './guided/plan.js';
