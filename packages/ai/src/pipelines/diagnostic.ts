import { FINDING_TYPES } from '@processia/model';
import { z } from 'zod';
import { loadPrompt } from '../prompts.js';
import type { PipelineDef } from '../runner.js';
import { DONNEES_CLOSE, DONNEES_OPEN } from './extraction.js';

const text = z.string().min(1);

// ------------------------------------------------------------------ entrée

export interface DiagnosticActivity {
  code: string;
  label: string;
  level: 'process' | 'task' | 'step';
  /** Code de l'activité parente. */
  parent: string;
  /** Libellé de l'acteur responsable. */
  actor?: string;
  execution: string;
}

/**
 * Entrée de `diagnostic` : un macroprocessus de l'AS-IS validé, avec ses activités, ses
 * décisions, ses flux d'information et ses indicateurs (contexte réduit au macroprocessus, risque
 * R-2), et les constats que les détecteurs déterministes ont déjà trouvés.
 */
export interface DiagnosticInput {
  macro: { code: string; label: string };
  activities: DiagnosticActivity[];
  decisions: { code: string; label: string; container: string }[];
  informationFlows: {
    code: string;
    label: string;
    from: string;
    to: string;
    channel: string;
    /** Code de l'activité qui émet le flux. */
    activity?: string;
  }[];
  indicators: {
    code: string;
    label: string;
    target: string;
    measure: string;
    value: string;
    unit: string;
  }[];
  /** Constats déjà trouvés (détecteurs) : ne pas les reproduire. */
  known: { type: string; locations: string[] }[];
}

// ------------------------------------------------------------------ sortie

export const diagnosticFindingSchema = z.object({
  type: z.enum(FINDING_TYPES),
  /** Codes d'activités, de décisions ou de flux d'information du macroprocessus (au moins un). */
  location: z.array(text).min(1).max(8),
  severity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  label: text.max(160),
  /** Justification lisible : ce qui est constaté, et pourquoi c'est un problème. */
  evidence: text,
});
export type DiagnosticFinding = z.infer<typeof diagnosticFindingSchema>;

export const diagnosticOutputSchema = z.object({
  findings: z.array(diagnosticFindingSchema).max(12),
  rationale: text,
});
export type DiagnosticOutput = z.infer<typeof diagnosticOutputSchema>;

/** Codes que la réponse peut désigner. */
export function diagnosticCodes(input: DiagnosticInput): Set<string> {
  return new Set([
    ...input.activities.map((a) => a.code),
    ...input.decisions.map((d) => d.code),
    ...input.informationFlows.map((f) => f.code),
  ]);
}

/** Contrôle sémantique : chaque constat est localisé sur des codes du macroprocessus. */
export function checkDiagnostic(
  output: DiagnosticOutput,
  input: DiagnosticInput,
): { path: string; message: string }[] {
  const codes = diagnosticCodes(input);
  const issues: { path: string; message: string }[] = [];
  output.findings.forEach((finding, i) => {
    for (const code of finding.location) {
      if (!codes.has(code)) {
        issues.push({
          path: `findings.${i}.location`,
          message: `« ${code} » n'est pas un élément du macroprocessus ${input.macro.code}.`,
        });
      }
    }
  });
  return issues;
}

// ------------------------------------------------------------------ pipeline

const donnees = (value: unknown): string =>
  `${DONNEES_OPEN}\n${JSON.stringify(value)}\n${DONNEES_CLOSE}`;

/** `diagnostic` (spécification 4.4) : constats d'un macroprocessus de l'AS-IS validé. */
export const diagnosticPipeline: PipelineDef<DiagnosticInput, DiagnosticOutput> = {
  name: 'diagnostic',
  version: '1',
  schemaName: 'Diagnostic',
  outputSchema: diagnosticOutputSchema,
  buildRequest: (input) => ({
    system: loadPrompt('diagnostic'),
    context: `Macroprocessus ${input.macro.code} « ${input.macro.label} » de l'AS-IS validé.`,
    messages: [{ role: 'user', content: donnees(input) }],
    maxOutputTokens: 8_000,
    effort: 'medium',
  }),
  semanticCheck: (output, input) => checkDiagnostic(output, input),
};
