import { z } from 'zod';
import { normalizeForMatch } from '../extraction/text.js';
import { loadPrompt } from '../prompts.js';
import type { PipelineDef } from '../runner.js';
import { DONNEES_CLOSE, DONNEES_OPEN } from './extraction.js';

const text = z.string().min(1);
const norm = normalizeForMatch;

/** Conteneur du processus lui-même, par opposition au code d'une tâche détaillée (niveau 3). */
export const FLOW_PROCESS_CONTAINER = 'process';

// ------------------------------------------------------------------ entrée

export interface FlowTaskInfo {
  code: string;
  label: string;
  description?: string;
  /** Libellé de l'acteur responsable. */
  actor?: string;
}

export interface ProcessFlowInput {
  /** `flow` : enchaînement du processus (niveau 2) ; `detail` : étapes des tâches choisies (niveau 3). */
  mode: 'flow' | 'detail';
  process: { code: string; label: string; description?: string; macro: string };
  /** Tâches du processus (niveau 2), dans l'ordre. */
  tasks: FlowTaskInfo[];
  /** Tâches à détailler (mode `detail`). */
  detailTasks: FlowTaskInfo[];
  actors: { code: string; label: string; category: string }[];
  /** Règles et objets de données déjà connus, pour les réutiliser. */
  rules: { code: string; label: string; type: string }[];
  dataObjects: { code: string; label: string }[];
}

// ------------------------------------------------------------------ sortie

export const flowNodeSchema = z.object({
  /** Référence locale, unique dans la réponse. */
  ref: text,
  /** `process` ou le code de la tâche détaillée. */
  container: text,
  kind: z.enum(['task', 'step', 'event', 'gateway']),
  label: text,
  description: text.optional(),
  /** Libellé exact d'un acteur connu (tâche, étape, événement, passerelle). */
  actor: text.optional(),
  execution: z.enum(['manual', 'user', 'automatic', 'ai_agent']).optional(),
  position: z.enum(['start', 'end', 'intermediate', 'boundary']).optional(),
  trigger: z.enum(['none', 'message', 'timer', 'error', 'signal', 'conditional']).optional(),
  /** Délai d'un événement de minuteur (« J+7 après la demande »). */
  timer: text.optional(),
  /** Tâche ou étape surveillée par un événement de bord. */
  attachedTo: text.optional(),
  gatewayType: z.enum(['exclusive', 'parallel', 'inclusive']).optional(),
  /** Règle de décision d'une passerelle (`ref` d'une règle de la réponse, ou code d'une règle connue). */
  rule: text.optional(),
  /** Objets de données lus ou produits par une tâche ou une étape (`ref` ou code). */
  inputs: z.array(text).optional(),
  outputs: z.array(text).optional(),
  rationale: text,
});
export type FlowNode = z.infer<typeof flowNodeSchema>;

export const flowEdgeSchema = z.object({
  container: text,
  /** `ref` d'un nœud de la réponse, ou code d'une tâche existante. */
  from: text,
  to: text,
  condition: text.optional(),
  isDefault: z.boolean().optional(),
  rule: text.optional(),
});
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

export const flowRuleSchema = z.object({
  ref: text,
  type: z.enum(['business', 'constraint', 'decision', 'exception', 'dependency']),
  label: text,
  text,
  when: text.optional(),
  then: text.optional(),
  otherwise: text.optional(),
  circuit: z.enum(['reminder', 'escalation', 'deadline', 'alert', 'other']).optional(),
  circuitDescription: text.optional(),
  /** Éléments visés (`ref` ou code). */
  appliesTo: z.array(text),
  legalReference: text.optional(),
  rationale: text,
});
export type FlowRule = z.infer<typeof flowRuleSchema>;

export const flowFieldSchema = z.object({
  name: text,
  type: z.enum(['text', 'number', 'amount', 'date', 'boolean', 'enum', 'file', 'reference']),
  required: z.boolean().optional(),
  enumValues: z.array(text).optional(),
  description: text.optional(),
  personalData: z.boolean().optional(),
});
export type FlowField = z.infer<typeof flowFieldSchema>;

export const flowDataObjectSchema = z.object({
  ref: text,
  label: text,
  nature: z.enum(['business_object', 'document', 'form']),
  fields: z.array(flowFieldSchema),
  rationale: text,
});
export type FlowDataObject = z.infer<typeof flowDataObjectSchema>;

export const flowIndicatorSchema = z.object({
  ref: text,
  label: text,
  /** Tâche ou étape mesurée (`ref` ou code). */
  target: text,
  measure: z.enum([
    'volume',
    'lead_time',
    'duration',
    'frequency',
    'workload',
    'cost',
    'error_rate',
  ]),
  exact: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  unit: text,
  period: z.enum(['day', 'week', 'month', 'year', 'occurrence']).optional(),
  nature: z.enum(['known', 'estimated']),
  rationale: text,
});
export type FlowIndicator = z.infer<typeof flowIndicatorSchema>;

export const flowInformationSchema = z.object({
  label: text,
  /** Libellés d'acteurs connus. */
  from: text,
  to: text,
  dataObjects: z.array(text),
  channel: z.enum(['paper', 'email', 'phone', 'software', 'portal', 'oral', 'other', 'unknown']),
  /** Tâche ou étape émettrice (`ref` ou code). */
  activity: text.optional(),
  frequency: text.optional(),
  rationale: text,
});
export type FlowInformation = z.infer<typeof flowInformationSchema>;

export const processFlowOutputSchema = z.object({
  nodes: z.array(flowNodeSchema).max(80),
  edges: z.array(flowEdgeSchema).max(160),
  rules: z.array(flowRuleSchema).max(24),
  dataObjects: z.array(flowDataObjectSchema).max(12),
  indicators: z.array(flowIndicatorSchema).max(12),
  informationFlows: z.array(flowInformationSchema).max(12),
  /** Justification générale de la proposition (reprise pour les éléments sans `rationale`). */
  rationale: text,
});
export type ProcessFlowOutput = z.infer<typeof processFlowOutputSchema>;

// ------------------------------------------------------------------ contrôle du graphe

interface Issue {
  path: string;
  message: string;
}

/**
 * Contrôles de graphe par conteneur, les mêmes que `checkCoherence` (CDC 4.2) : début, fin,
 * aucun nœud inatteignable, aucune impasse (`DEAD_END_BRANCH`). `known` : nœuds préexistants du
 * conteneur (tâches du processus). Fonction pure, réutilisée par le contrôle sémantique.
 */
export function checkContainerGraph(
  container: string,
  output: ProcessFlowOutput,
  known: readonly string[],
): Issue[] {
  const issues: Issue[] = [];
  const nodes = output.nodes.filter((n) => n.container === container);
  const members = new Set<string>([...known, ...nodes.map((n) => n.ref)]);
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    forward.set(from, [...(forward.get(from) ?? []), to]);
    backward.set(to, [...(backward.get(to) ?? []), from]);
  };
  output.edges.forEach((edge, i) => {
    if (edge.container !== container) return;
    for (const end of [edge.from, edge.to]) {
      if (!members.has(end)) {
        issues.push({
          path: `edges.${i}`,
          message: `« ${end} » n'est pas un nœud du conteneur « ${container} ».`,
        });
      }
    }
    if (members.has(edge.from) && members.has(edge.to)) link(edge.from, edge.to);
  });
  for (const n of nodes) {
    if (n.kind === 'event' && n.position === 'boundary' && n.attachedTo !== undefined) {
      if (members.has(n.attachedTo)) link(n.attachedTo, n.ref);
    }
  }
  const starts = nodes.filter((n) => n.kind === 'event' && n.position === 'start');
  const ends = nodes.filter((n) => n.kind === 'event' && n.position === 'end');
  if (starts.length === 0) {
    issues.push({ path: 'nodes', message: `Le conteneur « ${container} » n'a pas de début.` });
  }
  if (ends.length === 0) {
    issues.push({ path: 'nodes', message: `Le conteneur « ${container} » n'a pas de fin.` });
  }
  const reach = (from: string[], edges: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>();
    const stack = [...from];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of edges.get(id) ?? []) stack.push(next);
    }
    return seen;
  };
  if (starts.length > 0) {
    const reachable = reach(
      starts.map((n) => n.ref),
      forward,
    );
    for (const id of members) {
      if (!reachable.has(id)) {
        issues.push({ path: 'edges', message: `« ${id} » est inatteignable depuis le début.` });
      }
    }
  }
  if (ends.length > 0) {
    const canEnd = reach(
      ends.map((n) => n.ref),
      backward,
    );
    for (const id of members) {
      if (!canEnd.has(id)) {
        issues.push({ path: 'edges', message: `« ${id} » n'a aucun chemin vers une fin.` });
      }
    }
  }
  return issues;
}

/** Contrôle sémantique de `process.flow` : cohérence des références, des modes et des graphes. */
export function checkProcessFlow(output: ProcessFlowOutput, input: ProcessFlowInput): Issue[] {
  const issues: Issue[] = [];
  const add = (path: string, message: string): void => {
    issues.push({ path, message });
  };
  const detail = input.mode === 'detail';
  const actors = new Set(input.actors.map((a) => norm(a.label)));
  const existingCodes = new Set([
    ...input.tasks.map((t) => t.code),
    ...input.detailTasks.map((t) => t.code),
    ...input.rules.map((r) => r.code),
    ...input.dataObjects.map((d) => d.code),
  ]);

  // Références uniques.
  const refs = new Set<string>();
  const claim = (path: string, ref: string): void => {
    if (refs.has(ref)) add(path, `Référence en double : ${ref}.`);
    if (existingCodes.has(ref))
      add(path, `La référence ${ref} reprend le code d'un élément connu.`);
    refs.add(ref);
  };
  output.nodes.forEach((n, i) => claim(`nodes.${i}.ref`, n.ref));
  output.rules.forEach((r, i) => claim(`rules.${i}.ref`, r.ref));
  output.dataObjects.forEach((d, i) => claim(`dataObjects.${i}.ref`, d.ref));
  output.indicators.forEach((x, i) => claim(`indicators.${i}.ref`, x.ref));
  const known = (ref: string): boolean => refs.has(ref) || existingCodes.has(ref);
  const knownRule = (ref: string): boolean =>
    output.rules.some((r) => r.ref === ref) || input.rules.some((r) => r.code === ref);
  const knownData = (ref: string): boolean =>
    output.dataObjects.some((d) => d.ref === ref) || input.dataObjects.some((d) => d.code === ref);

  const detailCodes = new Set(input.detailTasks.map((t) => t.code));
  const containers = detail ? [...detailCodes] : [FLOW_PROCESS_CONTAINER];
  const validContainer = new Set(containers);

  output.nodes.forEach((n, i) => {
    const at = `nodes.${i}`;
    if (!validContainer.has(n.container)) {
      add(
        `${at}.container`,
        detail
          ? `Le conteneur doit être le code d'une tâche à détailler (${[...detailCodes].join(', ')}).`
          : `Le conteneur doit être « ${FLOW_PROCESS_CONTAINER} ».`,
      );
    }
    if (n.kind === 'step' && !detail)
      add(`${at}.kind`, 'Une étape ne se propose qu’en mode detail.');
    if (n.kind === 'task') {
      if (detail) add(`${at}.kind`, 'Une tâche ne se propose pas en mode detail.');
      else if (input.tasks.length > 0) {
        add(`${at}.kind`, 'Le processus a déjà des tâches : ne propose pas de nouvelle tâche.');
      }
    }
    if (n.actor !== undefined && !actors.has(norm(n.actor))) {
      add(`${at}.actor`, `Acteur inconnu : « ${n.actor} ». Utilise un libellé de la liste.`);
    }
    if ((n.kind === 'task' || n.kind === 'step') && n.actor === undefined) {
      add(`${at}.actor`, 'Une tâche ou une étape a un acteur.');
    }
    if (n.kind === 'event') {
      if (n.position === undefined) add(`${at}.position`, 'Un événement a une position.');
      if (n.position === 'boundary') {
        if (n.attachedTo === undefined) {
          add(`${at}.attachedTo`, 'Un événement de bord désigne la tâche ou l’étape surveillée.');
        } else if (!known(n.attachedTo)) {
          add(`${at}.attachedTo`, `Référence inconnue : ${n.attachedTo}.`);
        }
      }
      if (n.trigger === 'timer' && n.timer === undefined) {
        add(`${at}.timer`, 'Un minuteur précise son délai.');
      }
    }
    if (n.kind === 'gateway' && n.gatewayType === undefined) {
      add(`${at}.gatewayType`, 'Une passerelle a un type.');
    }
    if (n.rule !== undefined && !knownRule(n.rule))
      add(`${at}.rule`, `Règle inconnue : ${n.rule}.`);
    for (const d of [...(n.inputs ?? []), ...(n.outputs ?? [])]) {
      if (!knownData(d)) add(`${at}.inputs`, `Objet de données inconnu : ${d}.`);
    }
  });

  // Passerelles qui séparent le chemin : règle et conditions.
  output.nodes.forEach((n, i) => {
    if (n.kind !== 'gateway' || n.gatewayType === 'parallel') return;
    const out = output.edges.filter((e) => e.from === n.ref);
    if (out.length < 2) return;
    if (n.rule === undefined)
      add(`nodes.${i}.rule`, `La passerelle « ${n.label} » a besoin d'une règle de décision.`);
    for (const edge of out) {
      if (edge.condition === undefined && edge.isDefault !== true) {
        add('edges', `Un flux sortant de « ${n.label} » porte une condition ou isDefault.`);
      }
    }
  });

  // Chaque conteneur : tâches/étapes présentes et graphe sain.
  for (const container of containers) {
    const members = container === FLOW_PROCESS_CONTAINER ? input.tasks.map((t) => t.code) : [];
    for (const issue of checkContainerGraph(container, output, members)) issues.push(issue);
  }

  output.rules.forEach((r, i) => {
    for (const target of r.appliesTo) {
      if (!known(target)) add(`rules.${i}.appliesTo`, `Référence inconnue : ${target}.`);
    }
    if (r.type === 'exception' && (r.circuit === undefined || r.circuitDescription === undefined)) {
      add(`rules.${i}.circuit`, 'Une règle d’exception précise son circuit et sa description.');
    }
  });
  output.dataObjects.forEach((d, i) => {
    if (d.fields.length === 0) add(`dataObjects.${i}.fields`, 'Un objet de données a des champs.');
  });
  output.indicators.forEach((x, i) => {
    if (!known(x.target)) add(`indicators.${i}.target`, `Référence inconnue : ${x.target}.`);
    if (x.exact === undefined && x.min === undefined && x.max === undefined) {
      add(`indicators.${i}`, 'Un indicateur a une valeur (exact, min ou max).');
    }
  });
  output.informationFlows.forEach((f, i) => {
    for (const side of [f.from, f.to]) {
      if (!actors.has(norm(side))) add(`informationFlows.${i}`, `Acteur inconnu : « ${side} ».`);
    }
    for (const d of f.dataObjects) {
      if (!knownData(d))
        add(`informationFlows.${i}.dataObjects`, `Objet de données inconnu : ${d}.`);
    }
    if (f.activity !== undefined && !known(f.activity)) {
      add(`informationFlows.${i}.activity`, `Référence inconnue : ${f.activity}.`);
    }
  });
  if (detail && output.nodes.some((n) => n.container === FLOW_PROCESS_CONTAINER)) {
    add('nodes', 'Le mode detail ne modifie pas le conteneur du processus.');
  }
  if (!detail && output.dataObjects.length + output.informationFlows.length > 0) {
    add('dataObjects', 'Objets de données et flux d’information se proposent en mode detail.');
  }
  return issues;
}

// ------------------------------------------------------------------ pipeline

const donnees = (value: unknown): string =>
  `${DONNEES_OPEN}\n${JSON.stringify(value)}\n${DONNEES_CLOSE}`;

/** `process.flow` (spécification 4.4) : nœuds manquants et enchaînements d'un processus. */
export const processFlowPipeline: PipelineDef<ProcessFlowInput, ProcessFlowOutput> = {
  name: 'process.flow',
  version: '1',
  schemaName: 'ProcessFlow',
  outputSchema: processFlowOutputSchema,
  buildRequest: (input) => ({
    system: loadPrompt('process.flow'),
    context: `Processus ${input.process.code} « ${input.process.label} » (macroprocessus : ${input.process.macro}).`,
    messages: [{ role: 'user', content: donnees(input) }],
    maxOutputTokens: 16_000,
    effort: 'medium',
  }),
  semanticCheck: (output, input) => checkProcessFlow(output, input),
};
