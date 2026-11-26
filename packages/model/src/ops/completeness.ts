import type { BusinessModel } from '../schema/business-model.js';
import { CONCEPT_OF_KIND, CONCEPTS, type Concept } from '../schema/kinds.js';
import { elementsOfKind, hasOwner } from './coherence.js';
import type { CompletenessByConcept, CompletenessGap, CompletenessReport } from './types.js';

class Checks {
  satisfied = 0;
  applicable = 0;
  gaps: CompletenessGap[] = [];
  check(ok: boolean, check: string, message: string, elementId?: string): void {
    this.applicable += 1;
    if (ok) this.satisfied += 1;
    else this.gaps.push({ check, message, ...(elementId ? { elementId } : {}) });
  }
}

/**
 * Indicateur de complétude (CDC 3.7, spécification 2.5) [PO-10] : pour chaque concept, des
 * contrôles déterministes de poids égal. `score = satisfaits / applicables`. Chaque concept
 * porte au moins un contrôle d'existence : un modèle vide vaut 0.
 */
export function completeness(model: BusinessModel): CompletenessByConcept {
  const acts = elementsOfKind(model, 'activity');
  const actors = elementsOfKind(model, 'actor');
  const dataObjects = elementsOfKind(model, 'data_object');
  const flows = elementsOfKind(model, 'information_flow');
  const rules = elementsOfKind(model, 'rule');
  const gateways = elementsOfKind(model, 'gateway');
  const indicators = elementsOfKind(model, 'indicator');
  const traits = elementsOfKind(model, 'business_trait');
  const terms = elementsOfKind(model, 'glossary_term');
  const events = elementsOfKind(model, 'event');
  const seqFlows = elementsOfKind(model, 'sequence_flow');

  const by: Record<Concept, Checks> = Object.fromEntries(
    CONCEPTS.map((c) => [c, new Checks()]),
  ) as Record<Concept, Checks>;

  // Métier
  const b = by.business;
  for (const [facet, label] of [
    ['sector', 'Secteur'],
    ['environment', 'Environnement'],
    ['specificity', 'Au moins une spécificité'],
    ['summary', 'Synthèse'],
  ] as const) {
    b.check(
      traits.some((t) => t.facet === facet && t.text.trim() !== ''),
      `business.${facet}`,
      `${label} non renseigné`,
    );
  }
  for (const t of terms) {
    b.check(
      t.definition.trim() !== '',
      'business.term_definition',
      `Terme « ${t.term} » sans définition`,
      t.id,
    );
  }

  // Acteurs
  const a = by.actors;
  a.check(
    actors.some((x) => x.category === 'internal'),
    'actors.internal',
    'Aucun acteur interne',
  );
  const inRaci = new Set<string>();
  for (const act of acts) {
    for (const r of act.raci) inRaci.add(r.actorId);
    if (act.responsibleActorId) inRaci.add(act.responsibleActorId);
  }
  for (const f of flows) {
    inRaci.add(f.fromActorId);
    inRaci.add(f.toActorId);
  }
  for (const x of actors) {
    a.check(
      x.responsibilities.length > 0,
      'actors.responsibility',
      `Acteur « ${x.label} » sans responsabilité`,
      x.id,
    );
    a.check(
      inRaci.has(x.id),
      'actors.in_raci_or_flow',
      `Acteur « ${x.label} » absent des RACI et des flux`,
      x.id,
    );
  }

  // Activités
  const t = by.activities;
  const children = (id: string, level: string) =>
    acts.filter((c) => c.parentId === id && c.level === level);
  const macros = acts.filter((x) => x.level === 'macro');
  t.check(macros.length > 0, 'activities.macro', 'Aucun macroprocessus');
  for (const m of macros) {
    t.check(
      children(m.id, 'process').length > 0,
      'activities.macro_has_process',
      `Macroprocessus « ${m.label} » sans processus`,
      m.id,
    );
  }
  const containersWithNodes = new Set<string>([
    ...events.map((e) => e.containerId),
    ...gateways.map((g) => g.containerId),
    ...seqFlows.map((s) => s.containerId),
  ]);
  for (const p of acts.filter((x) => x.level === 'process')) {
    t.check(
      children(p.id, 'task').length > 0,
      'activities.process_has_task',
      `Processus « ${p.label} » sans tâche`,
      p.id,
    );
  }
  for (const c of acts.filter((x) => x.level === 'process' || x.level === 'task')) {
    if (!containersWithNodes.has(c.id)) continue;
    const inside = events.filter((e) => e.containerId === c.id);
    t.check(
      inside.some((e) => e.position === 'start'),
      'activities.has_start',
      `« ${c.label} » sans début`,
      c.id,
    );
    t.check(
      inside.some((e) => e.position === 'end'),
      'activities.has_end',
      `« ${c.label} » sans fin`,
      c.id,
    );
  }
  for (const k of acts.filter((x) => x.level === 'task')) {
    t.check(hasOwner(k), 'activities.task_owner', `Tâche « ${k.label} » sans responsable`, k.id);
  }

  // Données
  const d = by.data;
  d.check(dataObjects.length > 0, 'data.any', 'Aucun objet de donnée');
  const usedByActivity = new Set<string>();
  for (const act of acts) for (const o of [...act.inputs, ...act.outputs]) usedByActivity.add(o);
  for (const o of dataObjects) {
    d.check(
      usedByActivity.has(o.id),
      'data.used_by_activity',
      `Objet « ${o.label} » utilisé par aucune activité`,
      o.id,
    );
    if (o.nature === 'document' || o.nature === 'form') {
      d.check(o.fields.length > 0, 'data.has_field', `Objet « ${o.label} » sans champ`, o.id);
    }
  }

  // Flux
  const f = by.flows;
  f.check(flows.length > 0, 'flows.any', 'Aucun flux');
  for (const fl of flows) {
    const ends =
      model.elements[fl.fromActorId] !== undefined && model.elements[fl.toActorId] !== undefined;
    f.check(
      ends && fl.dataObjectIds.length > 0,
      'flows.complete',
      `Flux « ${fl.label} » sans émetteur, destinataire ou objet`,
      fl.id,
    );
    f.check(
      fl.channel !== 'unknown',
      'flows.channel',
      `Canal du flux « ${fl.label} » inconnu`,
      fl.id,
    );
  }

  // Règles
  const r = by.rules;
  r.check(rules.length > 0, 'rules.any', 'Aucune règle');
  for (const g of gateways.filter((x) => x.type === 'exclusive')) {
    r.check(
      g.ruleId !== undefined,
      'rules.gateway_rule',
      `Passerelle « ${g.label} » sans règle`,
      g.id,
    );
  }
  const ruleRefs = new Set<string>();
  for (const act of acts) for (const x of act.ruleIds) ruleRefs.add(x);
  for (const g of gateways) if (g.ruleId) ruleRefs.add(g.ruleId);
  for (const s of seqFlows) if (s.ruleId) ruleRefs.add(s.ruleId);
  for (const rule of rules) {
    r.check(
      rule.appliesTo.length > 0 || ruleRefs.has(rule.id),
      'rules.scope',
      `Règle « ${rule.label} » sans portée`,
      rule.id,
    );
    if (rule.type === 'exception') {
      r.check(
        rule.exceptionHandling !== undefined,
        'rules.exception_handling',
        `Exception « ${rule.label} » sans traitement`,
        rule.id,
      );
    }
  }

  // Indicateurs
  const i = by.indicators;
  i.check(indicators.length > 0, 'indicators.any', 'Aucun indicateur');
  for (const p of acts.filter((x) => x.level === 'process')) {
    const own = indicators.filter((x) => x.targetId === p.id);
    i.check(
      own.some((x) => x.measure === 'volume'),
      'indicators.volume',
      `Processus « ${p.label} » sans volume`,
      p.id,
    );
    i.check(
      own.some((x) => x.measure === 'lead_time' || x.measure === 'duration'),
      'indicators.lead_time',
      `Processus « ${p.label} » sans délai`,
      p.id,
    );
  }

  // Hypothèses en attente et questions ouvertes, par concept.
  const pending: Record<Concept, number> = Object.fromEntries(
    CONCEPTS.map((c) => [c, 0]),
  ) as Record<Concept, number>;
  const open: Record<Concept, number> = { ...pending };
  for (const el of Object.values(model.elements)) {
    if (el.kind === 'discrepancy') {
      if (el.state !== 'open') continue;
      const concepts = new Set<Concept>();
      for (const id of el.elementIds) {
        const target = model.elements[id];
        if (target && target.kind in CONCEPT_OF_KIND) {
          concepts.add(CONCEPT_OF_KIND[target.kind as keyof typeof CONCEPT_OF_KIND]);
        }
      }
      for (const c of concepts) open[c] += 1;
      continue;
    }
    if (el.kind === 'finding' || el.kind === 'optimisation') continue;
    if (el.status.value === 'hypothesis') pending[CONCEPT_OF_KIND[el.kind]] += 1;
  }

  const out = {} as CompletenessByConcept;
  for (const c of CONCEPTS) {
    const x = by[c];
    const report: CompletenessReport = {
      score: x.applicable === 0 ? 0 : x.satisfied / x.applicable,
      satisfied: x.satisfied,
      applicable: x.applicable,
      gaps: x.gaps,
      pendingHypotheses: pending[c],
      openQuestions: open[c],
    };
    out[c] = report;
  }
  return out;
}

/** Score global : moyenne des scores par concept (pondération égale). */
export function overallCompleteness(report: CompletenessByConcept): number {
  const scores = CONCEPTS.map((c) => report[c].score);
  return scores.reduce((s, x) => s + x, 0) / scores.length;
}
