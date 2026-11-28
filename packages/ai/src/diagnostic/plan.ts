import {
  FINDING_FAMILY_OF,
  type Activity,
  type BusinessModel,
  type Element,
  type FindingFamily,
  type FindingType,
} from '@processia/model';
import {
  type DiagnosticActivity,
  type DiagnosticInput,
  type DiagnosticOutput,
} from '../pipelines/diagnostic.js';

const MAX_ACTIVITIES = 160;

const byCode = (a: { code: string }, b: { code: string }): number =>
  a.code.localeCompare(b.code, 'fr', { numeric: true });

const activities = (model: BusinessModel): Activity[] =>
  Object.values(model.elements).filter((e): e is Activity => e.kind === 'activity');

/** Identifiants des activités sous un macroprocessus (processus, tâches, étapes). */
function scopeOf(model: BusinessModel, macroId: string): Set<string> {
  const all = activities(model);
  const ids = new Set<string>([macroId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of all) {
      if (a.parentId !== undefined && ids.has(a.parentId) && !ids.has(a.id)) {
        ids.add(a.id);
        grew = true;
      }
    }
  }
  return ids;
}

export interface DiagnosticMacro {
  id: string;
  code: string;
  label: string;
  /** Nombre de tâches et d'étapes : un macroprocessus sans tâche n'a rien à diagnostiquer. */
  taskCount: number;
}

/** Macroprocessus à diagnostiquer : ceux qui ont au moins une tâche, par code. */
export function listDiagnosticMacros(model: BusinessModel): DiagnosticMacro[] {
  const all = activities(model);
  return all
    .filter((a) => a.level === 'macro')
    .sort(byCode)
    .map((macro) => {
      const scope = scopeOf(model, macro.id);
      return {
        id: macro.id,
        code: macro.code,
        label: macro.label,
        taskCount: all.filter((a) => scope.has(a.id) && (a.level === 'task' || a.level === 'step'))
          .length,
      };
    })
    .filter((m) => m.taskCount > 0);
}

/**
 * Entrée du pipeline `diagnostic` pour un macroprocessus : contexte réduit à sa portée. `known` :
 * constats des détecteurs (type et éléments localisés) pour que l'IA ne les reproduise pas.
 */
export function buildDiagnosticInput(
  model: BusinessModel,
  macroId: string,
  known: readonly { type: string; location: readonly string[] }[] = [],
): DiagnosticInput {
  const macro = model.elements[macroId];
  if (macro?.kind !== 'activity' || macro.level !== 'macro') {
    throw new Error(`Macroprocessus introuvable : ${macroId}`);
  }
  const scope = scopeOf(model, macroId);
  const codeOf = (id: string): string | undefined => model.elements[id]?.code;
  const actorLabel = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : model.elements[id]?.label;

  const acts = activities(model)
    .filter((a) => scope.has(a.id) && a.level !== 'macro')
    .sort(byCode)
    .slice(0, MAX_ACTIVITIES);
  const containers = new Set(acts.map((a) => a.id));
  const elements = Object.values(model.elements);
  const decisions = elements
    .flatMap((e) =>
      e.kind === 'gateway' && containers.has(e.containerId) && e.type !== 'parallel' ? [e] : [],
    )
    .sort(byCode)
    .map((g) => ({
      code: g.code,
      label: g.label,
      container: codeOf(g.containerId) ?? '',
    }));
  const flows = elements
    .flatMap((e) =>
      e.kind === 'information_flow' && e.activityId !== undefined && containers.has(e.activityId)
        ? [e]
        : [],
    )
    .sort(byCode)
    .map((f) => ({
      code: f.code,
      label: f.label,
      from: actorLabel(f.fromActorId) ?? '',
      to: actorLabel(f.toActorId) ?? '',
      channel: f.channel,
      ...(f.activityId === undefined ? {} : { activity: codeOf(f.activityId) ?? '' }),
    }));
  const indicators = elements
    .flatMap((e) => (e.kind === 'indicator' && containers.has(e.targetId) ? [e] : []))
    .sort(byCode)
    .map((x) => ({
      code: x.code,
      label: x.label,
      target: codeOf(x.targetId) ?? '',
      measure: x.measure,
      value:
        x.value.exact !== undefined
          ? String(x.value.exact)
          : `${x.value.min ?? ''}–${x.value.max ?? ''}`,
      unit: x.unit,
    }));

  const inScope = new Set<string>([
    ...scope,
    ...elements.flatMap((e) =>
      (e.kind === 'gateway' && containers.has(e.containerId)) ||
      (e.kind === 'information_flow' && e.activityId !== undefined && containers.has(e.activityId))
        ? [e.id]
        : [],
    ),
  ]);
  return {
    macro: { code: macro.code, label: macro.label },
    activities: acts.map((a): DiagnosticActivity => ({
      code: a.code,
      label: a.label,
      level: a.level as DiagnosticActivity['level'],
      parent: codeOf(a.parentId ?? '') ?? '',
      ...(actorLabel(a.responsibleActorId) === undefined
        ? {}
        : { actor: actorLabel(a.responsibleActorId) as string }),
      execution: a.execution,
    })),
    decisions,
    informationFlows: flows,
    indicators,
    known: known
      .filter((k) => k.location.some((id) => inScope.has(id)))
      .map((k) => ({
        type: k.type,
        locations: k.location.flatMap((id) => {
          const code = codeOf(id);
          return code === undefined ? [] : [code];
        }),
      })),
  };
}

/** Constat de l'IA, localisé sur des éléments du modèle (même forme que `FindingCandidate`). */
export interface AiFindingCandidate {
  type: FindingType;
  family: FindingFamily;
  location: string[];
  severity: 1 | 2 | 3;
  label: string;
  evidence: string;
  detection: { by: 'ai' };
}

/**
 * Traduit les codes de la réponse en identifiants d'éléments du modèle. Un code inconnu n'arrive
 * pas jusqu'ici (contrôle sémantique du pipeline) ; par prudence il est ignoré, et un constat qui
 * perd toute localisation est écarté.
 */
export function resolveDiagnosticOutput(
  model: BusinessModel,
  macroId: string,
  output: DiagnosticOutput,
): AiFindingCandidate[] {
  const scope = scopeOf(model, macroId);
  const idByCode = new Map<string, string>();
  const claim = (e: Element): void => {
    idByCode.set(e.code, e.id);
  };
  const containers = new Set(
    activities(model)
      .filter((a) => scope.has(a.id))
      .map((a) => a.id),
  );
  for (const e of Object.values(model.elements)) {
    if (e.kind === 'activity' && scope.has(e.id)) claim(e);
    else if (e.kind === 'gateway' && containers.has(e.containerId)) claim(e);
    else if (
      e.kind === 'information_flow' &&
      e.activityId !== undefined &&
      containers.has(e.activityId)
    )
      claim(e);
  }
  const out: AiFindingCandidate[] = [];
  for (const finding of output.findings) {
    const location = [...new Set(finding.location.flatMap((code) => idByCode.get(code) ?? []))];
    if (location.length === 0) continue;
    out.push({
      type: finding.type,
      family: FINDING_FAMILY_OF[finding.type],
      location,
      severity: finding.severity,
      label: finding.label,
      evidence: finding.evidence,
      detection: { by: 'ai' },
    });
  }
  return out;
}
