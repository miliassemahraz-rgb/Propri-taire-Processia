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
