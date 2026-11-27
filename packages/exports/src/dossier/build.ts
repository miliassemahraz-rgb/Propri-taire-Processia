import type {
  DocBlock,
  DocSection,
  DocTable,
  DossierDocument,
  SourceKind,
} from '@processia/contracts';
import { t, type MessageKey } from '@processia/i18n';
import {
  deliverableView,
  raciMatrix,
  type Activity,
  type Actor,
  type BusinessModel,
  type BusinessTrait,
  type DataObject,
  type Element,
  type GlossaryTerm,
  type InformationFlow,
  type Provenance,
  type Rule,
  type SourceRef,
  type Tool,
} from '@processia/model';

/** Source d'un document ou d'un texte, telle que connue de la base. */
export interface DossierSource {
  id: string;
  kind: SourceKind;
  title: string;
  revision: number;
}

export interface DossierInput {
  /** Modèle complet de la version : la vue des livrables (sans hypothèse) est calculée ici. */
  model: BusinessModel;
  /** Sources de la mission, dans un ordre stable (les repères S1, S2… en découlent). */
  sources: DossierSource[];
  mission: { name: string; clientName: string };
  /** Date de la version du modèle (ISO) : le document ne dépend d'aucune horloge. */
  producedAt: string;
}

/** Traduit une clé construite dynamiquement (énumérations du modèle). */
const tk = (key: string, values?: Record<string, string | number>): string =>
  t(key as MessageKey, values);

const byCode = (a: { code: string }, b: { code: string }): number =>
  a.code.localeCompare(b.code, 'en', { numeric: true });

const MAX_QUOTE_CHARS = 400;
const FACET_ORDER = ['summary', 'activity_statement', 'sector', 'environment', 'specificity'];

type OfKind<K extends Element['kind']> = Extract<Element, { kind: K }>;

function ofKind<K extends Element['kind']>(model: BusinessModel, kind: K): OfKind<K>[] {
  return Object.values(model.elements)
    .filter((e): e is OfKind<K> => e.kind === kind)
    .sort(byCode);
}

/** Cible d'une citation : un élément, éventuellement un de ses champs. */
interface Cited {
  heading: string;
  provenance: Provenance;
}

class Tags {
  private readonly tags = new Map<string, string>();
  private readonly known: Map<string, DossierSource>;

  constructor(
    sources: DossierSource[],
    cited: Set<string>,
    readonly counts: Map<string, number>,
  ) {
    this.known = new Map(sources.map((s) => [s.id, s]));
    const ordered = [
      ...sources.map((s) => s.id).filter((id) => cited.has(id)),
      ...[...cited].filter((id) => !this.known.has(id)).sort(),
    ];
    ordered.forEach((id, index) => this.tags.set(id, `S${index + 1}`));
  }

  tag(sourceId: string): string {
    return this.tags.get(sourceId) ?? '';
  }

  /** Sources citées, dans l'ordre des repères. */
  entries(): { tag: string; id: string; source: DossierSource | undefined }[] {
    return [...this.tags.entries()].map(([id, tag]) => ({ tag, id, source: this.known.get(id) }));
  }

  /** Cellule « Sources » : repères distincts, ou à défaut l'origine de l'élément. */
  cell(provenance: Provenance): string {
    const tags = [...new Set(provenance.refs.map((r) => this.tag(r.sourceId)))].sort((a, b) =>
      a.localeCompare(b, 'en', { numeric: true }),
    );
    return tags.length > 0 ? tags.join(', ') : tk(`exports.origin.${provenance.origin}`);
  }
}

function locatorLabel(ref: SourceRef): string {
  const l = ref.locator;
  const parts: string[] = [];
  if (l.page !== undefined) parts.push(t('exports.locator.page', { page: l.page }));
  if (l.sheet !== undefined) parts.push(t('exports.locator.sheet', { sheet: l.sheet }));
  if (l.cell !== undefined) parts.push(t('exports.locator.cell', { cell: l.cell }));
  if (l.paragraph !== undefined) {
    parts.push(t('exports.locator.paragraph', { paragraph: l.paragraph }));
  }
  if (parts.length === 0) {
    parts.push(t('exports.locator.chars', { start: l.charStart, end: l.charEnd }));
  }
  return parts.join(t('exports.locator.join'));
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_QUOTE_CHARS
    ? flat
    : `${flat.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}${t('exports.value.ellipsis')}`;
}

const yesNo = (value: boolean | undefined): string =>
  value === undefined ? '' : t(value ? 'exports.value.yes' : 'exports.value.no');

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(iso),
  );
}

function table(
  id: string,
  options: {
    sheet: string;
    caption: string;
    empty: string;
    columns: string[];
    rows: string[][];
    rowHeader?: boolean;
  },
): DocTable {
  return {
    id,
    caption: options.caption,
    columns: options.columns,
    rows: options.rows,
    rowHeader: options.rowHeader ?? true,
    sheet: options.sheet,
    empty: options.empty,
  };
}

const tableBlock = (value: DocTable): DocBlock => ({ type: 'table', table: value });

/**
 * Projette le modèle en dossier d'analyse (CDC 3.5) : fiche métier et glossaire, acteurs et
 * matrice RACI, dictionnaire de données et flux, registre des règles, annexe des sources.
 *
 * Fonction pure : le modèle passe d'abord par `deliverableView`, qui retire toute hypothèse
 * (CDC 3.4) ; les éléments « Extrait » restent, avec leur statut et leur source [PO-11].
 * Aucune horloge ni aléa : le même modèle donne le même document.
 */
export function buildDossier(input: DossierInput): DossierDocument {
  const model = deliverableView(input.model);
  const label = (id: string): string => {
    const element = model.elements[id];
    return element === undefined ? '' : `${element.code} · ${element.label}`;
  };
  const labels = (ids: readonly string[] | undefined): string =>
    (ids ?? [])
      .map(label)
      .filter((x) => x !== '')
      .join('\n');

  // Éléments présentés dans les livrables, dans l'ordre des sections.
  const traits = ofKind(model, 'business_trait').sort(
    (a, b) => FACET_ORDER.indexOf(a.facet) - FACET_ORDER.indexOf(b.facet) || byCode(a, b),
  );
  const terms = ofKind(model, 'glossary_term');
  const actors = ofKind(model, 'actor');
  const raci = raciMatrix(model);
  const raciRows = raci.rows.filter((row) => Object.keys(row.roles).length > 0);
  const raciActivities = raciRows
    .map((row) => model.elements[row.activityId])
    .filter((e): e is Activity => e?.kind === 'activity');
  const dataObjects = ofKind(model, 'data_object');
  const tools = ofKind(model, 'tool');
  const flows = ofKind(model, 'information_flow');
  const rules = ofKind(model, 'rule');

  const shown: Element[] = [
    ...traits,
    ...terms,
    ...actors,
    ...raciActivities,
    ...dataObjects,
    ...tools,
    ...flows,
    ...rules,
  ];
  const citedList: Cited[] = [];
  for (const element of shown) {
    const heading = `${element.code} · ${element.label}`;
    citedList.push({ heading, provenance: element.provenance });
    if (element.kind === 'data_object') {
      for (const field of element.fields) {
        citedList.push({ heading: `${heading} › ${field.name}`, provenance: field.provenance });
      }
    }
  }
  const citedIds = new Set<string>();
  const counts = new Map<string, number>();
  for (const entry of citedList) {
    const seen = new Set<string>();
    for (const ref of entry.provenance.refs) {
      citedIds.add(ref.sourceId);
      if (!seen.has(ref.sourceId)) counts.set(ref.sourceId, (counts.get(ref.sourceId) ?? 0) + 1);
      seen.add(ref.sourceId);
    }
  }
  const tags = new Tags(input.sources, citedIds, counts);
  const status = (e: { status: { value: string } }): string =>
    tk(`exports.status.${e.status.value}`);

  // ------------------------------------------------------------------ 1. fiche métier et glossaire
  const traitsTable = table('traits', {
    sheet: t('exports.sheet.traits'),
    caption: t('exports.caption.traits'),
    empty: t('exports.empty.traits'),
    columns: [
      t('exports.col.code'),
      t('exports.col.facet'),
      t('exports.col.label'),
      t('exports.col.text'),
      t('exports.col.status'),
      t('exports.col.sources'),
    ],
    rows: traits.map((e: BusinessTrait) => [
      e.code,
      tk(`exports.facet.${e.facet}`),
      e.label,
      e.text,
      status(e),
      tags.cell(e.provenance),
    ]),
  });
  const glossaryTable = table('glossary', {
    sheet: t('exports.sheet.glossary'),
    caption: t('exports.caption.glossary'),
    empty: t('exports.empty.glossary'),
    columns: [
      t('exports.col.code'),
      t('exports.col.term'),
      t('exports.col.definition'),
      t('exports.col.synonyms'),
      t('exports.col.status'),
      t('exports.col.sources'),
    ],
    rows: terms.map((e: GlossaryTerm) => [
      e.code,
      e.term,
      e.definition,
      e.synonyms.join(', '),
      status(e),
      tags.cell(e.provenance),
    ]),
  });

  // ------------------------------------------------------------------ 2. acteurs et RACI
  const actorsTable = table('actors', {
    sheet: t('exports.sheet.actors'),
    caption: t('exports.caption.actors'),
    empty: t('exports.empty.actors'),
    columns: [
      t('exports.col.code'),
      t('exports.col.actor'),
      t('exports.col.category'),
      t('exports.col.responsibilities'),
      t('exports.col.stakeholder'),
      t('exports.col.status'),
      t('exports.col.sources'),
    ],
    rows: actors.map((e: Actor) => [
      e.code,
      e.label,
      tk(`exports.actorCategory.${e.category}`),
      e.responsibilities.join('\n'),
      yesNo(e.stakeholder ?? false),
      status(e),
      tags.cell(e.provenance),
    ]),
  });
  const separator = t('exports.raci.separator');
  const raciTable = table('raci', {
    sheet: t('exports.sheet.raci'),
    caption: t('exports.caption.raci'),
    empty: t('exports.empty.raci'),
    columns: [t('exports.raci.activity'), ...raci.actors.map((a) => `${a.code} · ${a.label}`)],
    rows:
      raciRows.length === 0
        ? []
        : raciRows.map((row) => [
            `${row.code} · ${row.label}`,
            ...raci.actors.map((a) => (row.roles[a.id] ?? []).join(separator)),
          ]),
  });
  const withoutRoles = raci.rows.length - raciRows.length;
  const raciActivitiesTable = table('raci_activities', {
    sheet: t('exports.sheet.raciActivities'),
    caption: t('exports.caption.raciActivities'),
    empty: t('exports.empty.raciActivities'),
    columns: [
      t('exports.col.code'),
      t('exports.col.activity'),
      t('exports.col.level'),
      t('exports.col.responsible'),
      t('exports.col.status'),
      t('exports.col.sources'),
    ],
    rows: raciActivities.map((e) => [
      e.code,
      e.label,
      tk(`exports.level.${e.level}`),
      e.responsibleActorId === undefined ? '' : label(e.responsibleActorId),
      status(e),
      tags.cell(e.provenance),
    ]),
  });

  // ------------------------------------------------------------------ 3. données et flux
  const objectsTable = table('data_objects', {
    sheet: t('exports.sheet.dataObjects'),
    caption: t('exports.caption.dataObjects'),
    empty: t('exports.empty.dataObjects'),
    columns: [
      t('exports.col.code'),
      t('exports.col.object'),
      t('exports.col.nature'),
      t('exports.col.tools'),
      t('exports.col.personalData'),
      t('exports.col.lifecycle'),
      t('exports.col.status'),
      t('exports.col.sources'),
    ],
    rows: dataObjects.map((e: DataObject) => [
      e.code,
      e.label,
      tk(`exports.dataNature.${e.nature}`),
      labels(e.toolIds),
      yesNo(e.personalData),
      (e.lifecycleStates ?? []).join(' → '),
      status(e),
      tags.cell(e.provenance),
    ]),
  });
  const fieldsTable = table('data_fields', {
    sheet: t('exports.sheet.dataFields'),
    caption: t('exports.caption.dataFields'),
    empty: t('exports.empty.dataFields'),
    columns: [
      t('exports.col.object'),
      t('exports.col.field'),
      t('exports.col.type'),
      t('exports.col.required'),
      t('exports.col.enumValues'),
      t('exports.col.reference'),
      t('exports.col.personalData'),
      t('exports.col.description'),
      t('exports.col.status'),
      t('exports.col.sources'),
    ],
    rows: dataObjects.flatMap((object) =>
      object.fields.map((field) => [
        `${object.code} · ${object.label}`,
        field.name,
        tk(`exports.fieldType.${field.type}`),
        yesNo(field.required),
        (field.enumValues ?? []).join(', '),
        field.referenceObjectId === undefined ? '' : label(field.referenceObjectId),
        yesNo(field.personalData),
        field.description ?? '',
        status(field),
        tags.cell(field.provenance),
      ]),
    ),
  });
  const toolsTable = table('tools', {
    sheet: t('exports.sheet.tools'),
    caption: t('exports.caption.tools'),
    empty: t('exports.empty.tools'),
    columns: [
      t('exports.col.code'),
      t('exports.col.tool'),
      t('exports.col.nature'),
      t('exports.col.system'),
      t('exports.col.status'),
      t('exports.col.sources'),
    ],
    rows: tools.map((e: Tool) => [
      e.code,
      e.label,
      tk(`exports.toolNature.${e.nature}`),
      e.systemActorId === undefined ? '' : label(e.systemActorId),
      status(e),
      tags.cell(e.provenance),
    ]),
  });
  const flowsTable = table('flows', {
    sheet: t('exports.sheet.flows'),
    caption: t('exports.caption.flows'),
    empty: t('exports.empty.flows'),
    columns: [
      t('exports.col.code'),
      t('exports.col.flow'),
      t('exports.col.from'),
      t('exports.col.to'),
      t('exports.col.data'),
      t('exports.col.channel'),
      t('exports.col.activity'),
      t('exports.col.frequency'),
      t('exports.col.status'),
      t('exports.col.sources'),
    ],
    rows: flows.map((e: InformationFlow) => [
      e.code,
      e.label,
      label(e.fromActorId),
      label(e.toActorId),
      labels(e.dataObjectIds),
      tk(`exports.channel.${e.channel}`),
      e.activityId === undefined ? '' : label(e.activityId),
      e.frequency ?? '',
      status(e),
      tags.cell(e.provenance),
    ]),
  });

  // ------------------------------------------------------------------ 4. registre des règles
  const rulesTable = table('rules', {
    sheet: t('exports.sheet.rules'),
    caption: t('exports.caption.rules'),
    empty: t('exports.empty.rules'),
    columns: [
      t('exports.col.code'),
      t('exports.col.rule'),
      t('exports.col.type'),
      t('exports.col.statement'),
      t('exports.col.appliesTo'),
      t('exports.col.dependsOn'),
      t('exports.col.exception'),
      t('exports.col.legal'),
      t('exports.col.status'),
      t('exports.col.sources'),
    ],
    rows: rules.map((e: Rule) => [
      e.code,
      e.label,
      tk(`exports.ruleType.${e.type}`),
      [
        e.statement.text,
        e.statement.when === undefined ? '' : t('exports.value.when', { text: e.statement.when }),
        e.statement.then === undefined ? '' : t('exports.value.then', { text: e.statement.then }),
        e.statement.otherwise === undefined
          ? ''
          : t('exports.value.otherwise', { text: e.statement.otherwise }),
      ]
        .filter((line) => line !== '')
        .join('\n'),
      labels(e.appliesTo),
      labels(e.dependsOn),
      e.exceptionHandling === undefined
        ? ''
        : t('exports.value.circuitLine', {
            circuit: tk(`exports.circuit.${e.exceptionHandling.circuit}`),
            description: e.exceptionHandling.description,
          }),
      e.legalReference ?? '',
      status(e),
      tags.cell(e.provenance),
    ]),
  });

  // ------------------------------------------------------------------ annexe
  const sourcesTable = table('sources', {
    sheet: t('exports.sheet.sources'),
    caption: t('exports.caption.sources'),
    empty: t('exports.empty.sources'),
    columns: [
      t('exports.col.tag'),
      t('exports.col.source'),
      t('exports.col.sourceKind'),
      t('exports.col.revision'),
      t('exports.col.citedBy'),
    ],
    rows: tags
      .entries()
      .map(({ tag, id, source }) => [
        tag,
        source?.title ?? t('exports.value.unknownSource'),
        source === undefined ? '' : tk(`exports.sourceKind.${source.kind}`),
        source === undefined ? '' : String(source.revision),
        String(counts.get(id) ?? 0),
      ]),
  });
  const citationsTable = table('citations', {
    sheet: t('exports.sheet.citations'),
    caption: t('exports.caption.citations'),
    empty: t('exports.empty.citations'),
    columns: [
      t('exports.col.element'),
      t('exports.col.source'),
      t('exports.col.where'),
      t('exports.col.quote'),
    ],
    rows: citedList.flatMap((entry) =>
      entry.provenance.refs.map((ref) => [
        entry.heading,
        tags.tag(ref.sourceId),
        locatorLabel(ref),
        truncate(ref.quote),
      ]),
    ),
  });

  // ------------------------------------------------------------------ assemblage
  const section = (id: string, blocks: DocBlock[]): DocSection => ({
    id,
    title: tk(`exports.deliverable.${id}`),
    blocks,
  });
  const raciBlocks: DocBlock[] = [];
  raciBlocks.push(tableBlock(actorsTable), tableBlock(raciTable));
  if (raciRows.length > 0) {
    raciBlocks.push({ type: 'note', text: t('exports.raci.legend') });
  }
  if (withoutRoles > 0) {
    raciBlocks.push({
      type: 'note',
      text: t('exports.raci.withoutRoles', { count: withoutRoles }),
    });
  }
  raciBlocks.push(tableBlock(raciActivitiesTable));

  const extracted = shown.filter((e) => e.status.value === 'extracted').length;
  const confirmed = shown.length - extracted;
  const notices = [t('exports.notice.noHypothesis')];
  if (extracted > 0) notices.push(t('exports.notice.extracted', { count: extracted }));
  notices.push(t('exports.notice.sourcesKey'));

  return {
    title: t('exports.document.title'),
    subtitle: t('exports.document.subtitle', {
      mission: input.mission.name,
      client: input.mission.clientName,
    }),
    language: 'fr',
    cover: [
      { label: t('exports.cover.mission'), value: input.mission.name },
      { label: t('exports.cover.client'), value: input.mission.clientName },
      {
        label: t('exports.cover.version'),
        value: t('exports.cover.versionValue', { version: model.version }),
      },
      { label: t('exports.cover.producedAt'), value: formatDate(input.producedAt) },
      {
        label: t('exports.cover.content'),
        value: t('exports.cover.contentValue', { confirmed, extracted }),
      },
    ],
    notices,
    deliverables: [
      section('business_sheet', [tableBlock(traitsTable), tableBlock(glossaryTable)]),
      section('actors_raci', raciBlocks),
      section('data_flows', [
        tableBlock(objectsTable),
        tableBlock(fieldsTable),
        tableBlock(toolsTable),
        tableBlock(flowsTable),
      ]),
      section('rules_register', [tableBlock(rulesTable)]),
    ],
    annex: section('annex', [tableBlock(sourcesTable), tableBlock(citationsTable)]),
    modelVersion: model.version,
  };
}

/** Tous les tableaux du document, dans l'ordre de lecture (livrables puis annexe). */
export function documentTables(doc: DossierDocument): DocTable[] {
  return [...doc.deliverables, doc.annex].flatMap((section) =>
    section.blocks.flatMap((block) => (block.type === 'table' ? [block.table] : [])),
  );
}
