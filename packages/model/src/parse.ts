import type { z } from 'zod';
import { migrateToCurrent } from './migrations/index.js';
import { type BusinessModel, BusinessModelSchema } from './schema/business-model.js';

export interface ParseIssue {
  /** Chemin lisible, ex. `elements.0190…-0001.provenance.refs`. */
  path: string;
  message: string;
}

export type ParseResult = { ok: true; model: BusinessModel } | { ok: false; errors: ParseIssue[] };

export function formatIssues(error: z.ZodError): ParseIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/** Migre puis valide un instantané JSON du modèle. Ne lève jamais d'exception. */
export function parseModel(json: unknown): ParseResult {
  const migrated = migrateToCurrent(json);
  if (!migrated.ok) {
    return { ok: false, errors: [{ path: 'schemaVersion', message: migrated.error }] };
  }
  const result = BusinessModelSchema.safeParse(migrated.value);
  if (result.success) return { ok: true, model: result.data };
  return { ok: false, errors: formatIssues(result.error) };
}
