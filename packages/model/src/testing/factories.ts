import { sequentialIdGenerator } from '../ids.js';
import type { Activity } from '../schema/activity.js';
import type { Actor } from '../schema/actor.js';
import type { BusinessModel } from '../schema/business-model.js';
import type { BusinessTrait } from '../schema/business-trait.js';
import type { DataField, DataObject } from '../schema/data-object.js';
import type { Discrepancy } from '../schema/discrepancy.js';
import type { Element } from '../schema/element.js';
import type { ProcessEvent } from '../schema/event.js';
import type { Finding } from '../schema/finding.js';
import type { Gateway } from '../schema/gateway.js';
import type { GlossaryTerm } from '../schema/glossary-term.js';
import type { Indicator } from '../schema/indicator.js';
import type { InformationFlow } from '../schema/information-flow.js';
import type { Optimisation } from '../schema/optimisation.js';
import type { ProcessLink } from '../schema/process-link.js';
import type { Provenance, SourceRef, StatusInfo } from '../schema/provenance.js';
import type { Rule } from '../schema/rule.js';
import type { SequenceFlow } from '../schema/sequence-flow.js';
import type { Tool } from '../schema/tool.js';

/** Date fixe : les fabriques sont déterministes (pas d'horloge implicite). */
export const TEST_DATE = '2026-01-15T09:00:00.000Z';
export const TEST_MISSION_ID = 'mission-test';

let nextId = sequentialIdGenerator();
let nextCode = 0;

/** Remet à zéro les identifiants et codes générés par les fabriques (à appeler en `beforeEach`). */
export function resetTestIds(): void {
  nextId = sequentialIdGenerator();
  nextCode = 0;
}
export function testId(): string {
  return nextId();
}
function testCode(prefix: string): string {
  nextCode += 1;
  return `${prefix}-${String(nextCode).padStart(2, '0')}`;
}

export function buildSourceRef(overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    sourceId: '01900000-ffff-7000-8000-000000000001',
    sourceRevision: 1,
    locator: { paragraph: 1, charStart: 0, charEnd: 24 },
    quote: 'Nous relançons les clients',
    ...overrides,
  };
}

export function buildProvenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    origin: 'consultant',
    refs: [],
    author: { type: 'user', userId: 'user-1' },
    at: TEST_DATE,
    ...overrides,
  };
}

export function buildStatus(overrides: Partial<StatusInfo> = {}): StatusInfo {
  return { value: 'confirmed', decidedBy: 'user-1', decidedAt: TEST_DATE, ...overrides };
}

/** Champs communs : un élément `confirmed`, d'origine consultant. */
function base(prefix: string) {
  return {
    id: testId(),
    code: testCode(prefix),
    label: 'Libellé',
    provenance: buildProvenance(),
    status: buildStatus(),
    meta: { createdInVersion: 1, updatedInVersion: 1 },
  };
}

export function buildBusinessTrait(o: Partial<BusinessTrait> = {}): BusinessTrait {
  return {
    ...base('TRT'),
    kind: 'business_trait',
    facet: 'sector',
    text: 'Cabinet d’expertise comptable',
    ...o,
  };
}
export function buildGlossaryTerm(o: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    ...base('TRM'),
    kind: 'glossary_term',
    term: 'Liasse',
    definition: 'Ensemble des documents fiscaux de fin d’exercice',
    synonyms: [],
    ...o,
  };
}
export function buildActor(o: Partial<Actor> = {}): Actor {
  return {
    ...base('ACT'),
    kind: 'actor',
    category: 'internal',
    responsibilities: ['Saisir les pièces'],
    ...o,
  };
}
export function buildActivity(o: Partial<Activity> = {}): Activity {
  return {
    ...base('P'),
    kind: 'activity',
    level: 'macro',
    raci: [],
    inputs: [],
    outputs: [],
    toolIds: [],
    ruleIds: [],
    execution: 'manual',
    ...o,
  };
}
export function buildEvent(o: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    ...base('EVT'),
    kind: 'event',
    containerId: testId(),
    position: 'start',
    trigger: 'none',
    ...o,
  };
}
export function buildGateway(o: Partial<Gateway> = {}): Gateway {
  return { ...base('GW'), kind: 'gateway', containerId: testId(), type: 'exclusive', ...o };
}
export function buildSequenceFlow(o: Partial<SequenceFlow> = {}): SequenceFlow {
  return {
    ...base('SEQ'),
    kind: 'sequence_flow',
    containerId: testId(),
    fromId: testId(),
    toId: testId(),
    ...o,
  };
}
export function buildProcessLink(o: Partial<ProcessLink> = {}): ProcessLink {
  return {
    ...base('LNK'),
    kind: 'process_link',
    fromId: testId(),
    toId: testId(),
    nature: 'sequence',
    ...o,
  };
}
export function buildDataField(o: Partial<DataField> = {}): DataField {
  return {
    id: testId(),
    name: 'Montant',
    type: 'amount',
    provenance: buildProvenance(),
    status: buildStatus(),
    ...o,
  };
}
export function buildDataObject(o: Partial<DataObject> = {}): DataObject {
  return {
    ...base('DON'),
    kind: 'data_object',
    nature: 'document',
    fields: [],
    toolIds: [],
    ...o,
  };
}
export function buildTool(o: Partial<Tool> = {}): Tool {
  return { ...base('OUT'), kind: 'tool', nature: 'software', ...o };
}
export function buildInformationFlow(o: Partial<InformationFlow> = {}): InformationFlow {
  return {
    ...base('FLX'),
    kind: 'information_flow',
    fromActorId: testId(),
    toActorId: testId(),
    dataObjectIds: [],
    channel: 'email',
    ...o,
  };
}
export function buildRule(o: Partial<Rule> = {}): Rule {
  return {
    ...base('RG'),
    kind: 'rule',
    type: 'business',
    statement: { text: 'Une pièce manquante est relancée sous 7 jours' },
    appliesTo: [],
    ...o,
  };
}
export function buildIndicator(o: Partial<Indicator> = {}): Indicator {
  return {
    ...base('IND'),
    kind: 'indicator',
    targetId: testId(),
    measure: 'volume',
    value: { exact: 120 },
    unit: 'dossiers',
    period: 'month',
    nature: 'estimated',
    ...o,
  };
}
export function buildDiscrepancy(o: Partial<Discrepancy> = {}): Discrepancy {
  return {
    ...base('ECA'),
    kind: 'discrepancy',
    elementIds: [],
    sides: [
      { claim: 'Délai de 7 jours', refs: [buildSourceRef()] },
      { claim: 'Délai de 15 jours', refs: [buildSourceRef()] },
    ],
    state: 'open',
    ...o,
  };
}
export function buildFinding(o: Partial<Finding> = {}): Finding {
  return {
    ...base('CST'),
    kind: 'finding',
    family: 'waste',
    type: 'rekeying',
    location: [testId()],
    severity: 2,
    detection: { by: 'rule', detectorId: 'rekeying' },
    ...o,
  };
}
export function buildOptimisation(o: Partial<Optimisation> = {}): Optimisation {
  return {
    ...base('OPT'),
    kind: 'optimisation',
    findingIds: [testId()],
    changeSet: { baseVersion: 1, ops: [], cause: 'optimisation', summary: 'Aucune modification' },
    touchedElementIds: [],
    dependsOn: [],
    gain: {
      assumptions: [],
      formula: 'volume × durée',
      score: 3,
    },
    effort: {
      score: 2,
      justification: 'Configuration du moteur',
      drivers: ['engine_configuration'],
    },
    ...o,
  };
}

/** Modèle valide ne contenant que les éléments donnés. */
export function buildModel(
  elements: Element[] = [],
  overrides: Partial<BusinessModel> = {},
): BusinessModel {
  return {
    schemaVersion: 1,
    missionId: TEST_MISSION_ID,
    version: 1,
    elements: Object.fromEntries(elements.map((e) => [e.id, e])),
    rejectedHypotheses: [],
    layout: {},
    ...overrides,
  };
}
