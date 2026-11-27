import type { DossierDocument } from '@processia/contracts';
import { messages } from '@processia/i18n';
import {
  buildActivity,
  buildActor,
  buildBusinessTrait,
  buildCompleteModel,
  buildDataField,
  buildDataObject,
  buildGlossaryTerm,
  buildInformationFlow,
  buildProvenance,
  buildRule,
  buildSourceRef,
  buildStatus,
  buildTool,
  type BusinessModel,
  type Element,
} from '@processia/model';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';
import {
  buildDossier,
  documentTables,
  renderDocx,
  renderDossierHtml,
  renderXlsx,
  sha256Hex,
  sheetName,
  type DossierSource,
} from './index.js';

const PRODUCED_AT = '2026-11-27T10:00:00.000Z';
const SOURCE_A = '01900000-aaaa-7000-8000-00000000000a';
const SOURCE_B = '01900000-aaaa-7000-8000-00000000000b';
const SOURCE_ONLY_HYPOTHESIS = '01900000-aaaa-7000-8000-00000000000c';
const SOURCES: DossierSource[] = [
  { id: SOURCE_A, kind: 'free_text', title: 'Description du cabinet', revision: 2 },
  { id: SOURCE_B, kind: 'document', title: 'Procédure de collecte.pdf', revision: 1 },
  {
    id: SOURCE_ONLY_HYPOTHESIS,
    kind: 'document',
    title: 'Note réservée aux hypothèses',
    revision: 1,
  },
];
const MISSION = { name: 'Mission pilote', clientName: 'Cabinet Exemple' };
const SECRET = 'HYPOTHESE-INTERDITE';

/** Code d'un élément du modèle complet (les codes des fabriques suivent l'ordre de création). */
function codeOf(label: string): string {
  const found = Object.values(buildCompleteModel().elements).find((e) => e.label === label);
  if (found === undefined) throw new Error(`Élément absent : ${label}`);
  return found.code;
}
const ACCOUNTANT = `${codeOf('Comptable')} · Comptable`;
const CLIENT = `${codeOf('Client')} · Client`;
const RELANCE = `${codeOf('Relance des pièces manquantes')} · Relance des pièces manquantes`;

function withElements(model: BusinessModel, elements: Element[]): BusinessModel {
  return {
    ...model,
    elements: { ...model.elements, ...Object.fromEntries(elements.map((e) => [e.id, e])) },
  };
}

/** Modèle complet + un élément « Extrait » cité + des hypothèses de chaque sorte. */
function modelWithHypotheses(): BusinessModel {
  const base = buildCompleteModel();
  const extracted = buildBusinessTrait({
    code: 'TRT-90',
    label: 'Particularité lue',
    facet: 'specificity',
    text: 'Dix étapes de la prospection au pilotage',
    status: buildStatus({ value: 'extracted' }),
    provenance: buildProvenance({
      origin: 'free_text',
      refs: [buildSourceRef({ sourceId: SOURCE_A, sourceRevision: 2, quote: 'Dix étapes' })],
    }),
  });
  const hypothesisProvenance = buildProvenance({
    origin: 'ai_knowledge',
    rationale: 'Connaissance du secteur',
    refs: [buildSourceRef({ sourceId: SOURCE_ONLY_HYPOTHESIS, quote: SECRET })],
    author: { type: 'ai' },
  });
  const hypothesis = (
    f: (o: { status: Element['status']; provenance: typeof hypothesisProvenance }) => Element,
  ): Element =>
    f({ status: buildStatus({ value: 'hypothesis' }), provenance: hypothesisProvenance });
  const hypotheses: Element[] = [
    hypothesis((o) => buildBusinessTrait({ ...o, code: 'TRT-91', label: SECRET, text: SECRET })),
    hypothesis((o) =>
      buildGlossaryTerm({ ...o, code: 'TRM-91', label: SECRET, term: SECRET, definition: SECRET }),
    ),
    hypothesis((o) => buildActor({ ...o, code: 'ACT-91', label: SECRET })),
    hypothesis((o) => buildTool({ ...o, code: 'OUT-91', label: SECRET })),
    hypothesis((o) =>
      buildRule({ ...o, code: 'RG-91', label: SECRET, statement: { text: SECRET } }),
    ),
    hypothesis((o) =>
      buildActivity({
        ...o,
        code: 'P91',
        label: SECRET,
        level: 'macro',
        raci: [],
      }),
    ),
  ];
  // Un champ hypothétique dans un objet confirmé.
  const objects = Object.values(base.elements).filter((e) => e.kind === 'data_object');
  const first = objects[0];
  if (first?.kind !== 'data_object') throw new Error('objet attendu');
  const withField = {
    ...first,
    fields: [
      ...first.fields,
      buildDataField({
        name: SECRET,
        status: buildStatus({ value: 'hypothesis' }),
        provenance: hypothesisProvenance,
      }),
    ],
  };
  return withElements(base, [extracted, ...hypotheses, withField]);
}

/** Tout le texte du document, pour y chercher une chaîne. */
function allText(doc: DossierDocument): string {
  const parts: string[] = [doc.title, doc.subtitle, ...doc.notices];
  parts.push(...doc.cover.flatMap((c) => [c.label, c.value]));
  for (const table of documentTables(doc)) {
    parts.push(table.caption, table.empty, ...table.columns, ...table.rows.flat());
  }
  return parts.join('\n');
}

const build = (model: BusinessModel): DossierDocument =>
  buildDossier({ model, sources: SOURCES, mission: MISSION, producedAt: PRODUCED_AT });

describe('buildDossier', () => {
  it('produit les 4 livrables et l’annexe, avec les en-têtes issus du catalogue i18n', () => {
    const doc = build(buildCompleteModel());
    expect(doc.deliverables.map((s) => s.title)).toEqual([
      messages.exports.deliverable.business_sheet,
      messages.exports.deliverable.actors_raci,
      messages.exports.deliverable.data_flows,
      messages.exports.deliverable.rules_register,
    ]);
    expect(doc.annex.title).toBe(messages.exports.deliverable.annex);
    expect(documentTables(doc).map((x) => x.id)).toEqual([
      'traits',
      'glossary',
      'actors',
      'raci',
      'raci_activities',
      'data_objects',
      'data_fields',
      'tools',
      'flows',
      'rules',
      'sources',
      'citations',
    ]);
    const rules = documentTables(doc).find((x) => x.id === 'rules');
    expect(rules?.columns).toContain(messages.exports.col.statement);
    expect(rules?.rows.length).toBe(2);
    const sheets = documentTables(doc).map((x) => x.sheet);
    expect(new Set(sheets.map((s) => s.toLowerCase())).size).toBe(sheets.length);
    for (const name of sheets) expect(name.length).toBeLessThanOrEqual(31);
  });

  it('matrice RACI : en-têtes de lignes (activités) et de colonnes (acteurs), rôles ordonnés', () => {
    const doc = build(buildCompleteModel());
    const raci = documentTables(doc).find((x) => x.id === 'raci');
    if (raci === undefined) throw new Error('RACI manquante');
    expect(raci.rowHeader).toBe(true);
    expect(raci.columns[0]).toBe(messages.exports.raci.activity);
    expect(raci.columns.slice(1)).toEqual([ACCOUNTANT, CLIENT]);
    expect(raci.rows).toEqual([
      [RELANCE, 'R', 'I'],
      [`${codeOf('Envoyer la relance')} · Envoyer la relance`, 'R', ''],
    ]);
  });

  it('exclut toute hypothèse (élément, champ, source citée par elle seule) [CDC 3.4]', () => {
    const doc = build(modelWithHypotheses());
    expect(allText(doc)).not.toContain(SECRET);
    expect(allText(doc)).not.toContain('Note réservée aux hypothèses');
    expect(allText(doc)).not.toContain('P91');
  });

  it('garde les éléments « Extrait » avec leur statut et leur source [PO-11]', () => {
    const doc = build(modelWithHypotheses());
    const traits = documentTables(doc).find((x) => x.id === 'traits');
    const row = traits?.rows.find((r) => r[0] === 'TRT-90');
    expect(row).toEqual([
      'TRT-90',
      messages.exports.facet.specificity,
      'Particularité lue',
      'Dix étapes de la prospection au pilotage',
      messages.exports.status.extracted,
      'S1',
    ]);
    const sources = documentTables(doc).find((x) => x.id === 'sources');
    expect(sources?.rows).toEqual([
      ['S1', 'Description du cabinet', messages.exports.sourceKind.free_text, '2', '1'],
    ]);
    const citations = documentTables(doc).find((x) => x.id === 'citations');
    expect(citations?.rows).toEqual([
      ['TRT-90 · Particularité lue', 'S1', 'paragraphe 1', 'Dix étapes'],
    ]);
    expect(doc.notices.some((n) => n.includes('« Extrait »'))).toBe(true);
    // Sans élément extrait : pas de mention.
    expect(build(buildCompleteModel()).notices.some((n) => n.includes('« Extrait »'))).toBe(false);
  });

  it('à défaut de source citée, la cellule « Sources » indique l’origine', () => {
    const doc = build(buildCompleteModel());
    const traits = documentTables(doc).find((x) => x.id === 'traits');
    expect(traits?.rows[0]?.at(-1)).toBe(messages.exports.origin.consultant);
  });

  it('une source inconnue est signalée plutôt que perdue', () => {
    const trait = buildBusinessTrait({
      code: 'TRT-70',
      provenance: buildProvenance({
        origin: 'document',
        refs: [buildSourceRef({ sourceId: '01900000-aaaa-7000-8000-0000000000ff' })],
      }),
    });
    const doc = buildDossier({
      model: withElements(buildCompleteModel(), [trait]),
      sources: [],
      mission: MISSION,
      producedAt: PRODUCED_AT,
    });
    const sources = documentTables(doc).find((x) => x.id === 'sources');
    expect(sources?.rows[0]?.[1]).toBe(messages.exports.value.unknownSource);
  });

  it('couvre toutes les énumérations du modèle par un libellé du catalogue', () => {
    const base = buildCompleteModel();
    const natures = ['business_object', 'document', 'form'] as const;
    const fieldTypes = [
      'text',
      'number',
      'amount',
      'date',
      'boolean',
      'enum',
      'file',
      'reference',
    ] as const;
    const objects = natures.map((nature, index) =>
      buildDataObject({
        code: `DON-8${index}`,
        nature,
        personalData: true,
        lifecycleStates: ['ouvert', 'clos'],
        fields:
          index === 0
            ? fieldTypes.map((type) =>
                buildDataField({
                  name: `champ ${type}`,
                  type,
                  required: true,
                  enumValues: ['a', 'b'],
                  personalData: false,
                }),
              )
            : [],
      }),
    );
    const tools = (['software', 'spreadsheet', 'email', 'paper', 'phone', 'other'] as const).map(
      (nature, i) => buildTool({ code: `OUT-8${i}`, nature }),
    );
    const actors = (['internal', 'external', 'third_party_system'] as const).map((category, i) =>
      buildActor({ code: `ACT-8${i}`, category }),
    );
    const [a, b] = actors;
    if (a === undefined || b === undefined) throw new Error('acteurs');
    const channels = (
      ['paper', 'email', 'phone', 'software', 'portal', 'oral', 'other', 'unknown'] as const
    ).map((channel, i) =>
      buildInformationFlow({
        code: `FLX-8${i}`,
        channel,
        fromActorId: a.id,
        toActorId: b.id,
        frequency: 'chaque jour',
      }),
    );
    const rules = (['business', 'constraint', 'decision', 'exception', 'dependency'] as const).map(
      (type, i) =>
        buildRule({
          code: `RG-8${i}`,
          type,
          legalReference: 'Article 12',
          statement: { text: 'Texte', when: 'quand', then: 'alors', otherwise: 'sinon' },
          exceptionHandling: {
            circuit:
              (['reminder', 'escalation', 'deadline', 'alert', 'other'] as const)[i] ?? 'other',
            description: 'Circuit',
          },
        }),
    );
    const levels = (['macro', 'process', 'task', 'step'] as const).map((level, i) =>
      buildActivity({
        code: `P8${i}`,
        level,
        parentId: level === 'macro' ? undefined : (Object.values(base.elements)[0]?.id ?? ''),
        responsibleActorId: a.id,
      }),
    );
    const facets = (
      ['sector', 'environment', 'specificity', 'summary', 'activity_statement'] as const
    ).map((facet, i) => buildBusinessTrait({ code: `TRT-8${i}`, facet }));
    const origins = (
      [
        'free_text',
        'answer',
        'document',
        'interview',
        'system_log',
        'ai_knowledge',
        'past_mission',
        'consultant',
        'deterministic_rule',
      ] as const
    ).map((origin, i) =>
      buildBusinessTrait({
        code: `TRT-7${i}`,
        provenance: buildProvenance({ origin, rationale: 'Justification' }),
      }),
    );
    const model = withElements(base, [
      ...objects,
      ...tools,
      ...actors,
      ...channels,
      ...rules,
      ...levels,
      ...facets,
      ...origins,
    ]);
    expect(() => build(model)).not.toThrow();
    for (const table of documentTables(build(model))) {
      for (const cell of table.rows.flat()) expect(cell).not.toMatch(/^exports\./);
    }
  });

  it('est déterministe : même modèle, même document', () => {
    const model = modelWithHypotheses();
    expect(JSON.stringify(build(model))).toBe(JSON.stringify(build(model)));
  });

  it('modèle vide : 4 livrables, tableaux vides avec leur texte', () => {
    const doc = build({ ...buildCompleteModel(), elements: {} });
    expect(doc.deliverables).toHaveLength(4);
    for (const table of documentTables(doc)) {
      expect(table.rows).toEqual([]);
      expect(table.empty).not.toBe('');
    }
    expect(renderDossierHtml(doc)).toContain(messages.exports.empty.rules);
  });
});

describe('DOCX (relu avec mammoth)', () => {
  it('contient les 4 sections, la matrice RACI et les sources en annexe', async () => {
    const doc = build(modelWithHypotheses());
    const bytes = await renderDocx(doc, PRODUCED_AT);
    const buffer = Buffer.from(bytes);
    const html = (await mammoth.convertToHtml({ buffer })).value;
    const text = (await mammoth.extractRawText({ buffer })).value;
    for (const title of [...doc.deliverables.map((s) => s.title), doc.annex.title]) {
      expect(html).toContain(`<h1>${title}</h1>`);
    }
    // Matrice RACI : activité en ligne, acteurs en colonnes.
    expect(html).toContain(ACCOUNTANT);
    expect(html).toContain(RELANCE);
    expect(html).toContain(`<h2>${messages.exports.caption.raci}</h2>`);
    // Sources en annexe.
    expect(html).toContain('Description du cabinet');
    expect(html).toContain('Dix étapes');
    expect(text).toContain(messages.exports.col.quote);
    // Aucune hypothèse.
    expect(text).not.toContain(SECRET);
  });

  it('est identique d’un rendu à l’autre (empreinte sha256)', async () => {
    const doc = build(modelWithHypotheses());
    const first = await renderDocx(doc, PRODUCED_AT);
    const second = await renderDocx(doc, PRODUCED_AT);
    expect(sha256Hex(first)).toBe(sha256Hex(second));
    const zip = await JSZip.loadAsync(first);
    const core = await zip.file('docProps/core.xml')?.async('string');
    expect(core).toContain('2026-11-27T10:00:00Z');
  });
});

describe('XLSX (relu avec exceljs)', () => {
  async function read(doc: DossierDocument): Promise<ExcelJS.Workbook> {
    const bytes = await renderXlsx(doc, PRODUCED_AT);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    return workbook;
  }

  it('contient les feuilles attendues, avec les en-têtes i18n', async () => {
    const workbook = await read(build(modelWithHypotheses()));
    const names = workbook.worksheets.map((s) => s.name);
    expect(names).toEqual([
      'Présentation',
      'Fiche métier',
      'Glossaire',
      'Acteurs',
      'RACI',
      'Activités du RACI',
      'Objets de données',
      'Champs de données',
      'Outils',
      'Flux',
      'Règles',
      'Sources',
      'Citations',
    ]);
    const raci = workbook.getWorksheet('RACI');
    expect(raci?.getRow(1).values).toEqual([
      undefined,
      messages.exports.raci.activity,
      ACCOUNTANT,
      CLIENT,
    ]);
    expect(raci?.getRow(2).values).toEqual([undefined, RELANCE, 'R', 'I']);
    const rules = workbook.getWorksheet('Règles');
    expect((rules?.getRow(1).values as string[]).slice(1)).toContain(
      messages.exports.col.statement,
    );
    expect(rules?.rowCount).toBe(3);
    const fields = workbook.getWorksheet('Champs de données');
    expect((fields?.getRow(1).values as string[]).slice(1, 4)).toEqual([
      messages.exports.col.object,
      messages.exports.col.field,
      messages.exports.col.type,
    ]);
  });

  it('ne contient aucune hypothèse et garde les feuilles vides pour un modèle vide', async () => {
    const workbook = await read(build(modelWithHypotheses()));
    let found = false;
    workbook.eachSheet((sheet) =>
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          if (String(cell.value ?? '').includes(SECRET)) found = true;
        }),
      ),
    );
    expect(found).toBe(false);
    const empty = await read(build({ ...buildCompleteModel(), elements: {} }));
    expect(empty.worksheets).toHaveLength(13);
    expect(empty.getWorksheet('Règles')?.rowCount).toBe(1);
  });

  it('est identique d’un rendu à l’autre (empreinte sha256)', async () => {
    const doc = build(modelWithHypotheses());
    const first = await renderXlsx(doc, PRODUCED_AT);
    // Une seconde d'écart : aucune date du jour ne doit se glisser dans l'archive.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await renderXlsx(doc, PRODUCED_AT);
    expect(sha256Hex(first)).toBe(sha256Hex(second));
  });

  it('nomme les feuilles sans caractère interdit ni doublon', () => {
    const taken = new Set<string>();
    expect(sheetName('A/B:C?[x]', taken)).toBe('A B C  x');
    expect(sheetName('A/B:C?[x]', taken)).toBe('A B C  x 2');
    expect(sheetName('x'.repeat(40), taken)).toHaveLength(31);
  });
});

describe('gabarit HTML du PDF', () => {
  it('a des titres (signets), des en-têtes de lignes et de colonnes, et la langue du document', () => {
    const html = renderDossierHtml(build(modelWithHypotheses()));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain(`<h1>${messages.exports.document.title}</h1>`);
    expect(html).toContain(`>${messages.exports.deliverable.rules_register}</h2>`);
    expect(html).toMatch(/<th scope="col">/);
    expect(html).toContain(`<th scope="row">${RELANCE}</th>`);
    expect(html).toContain(`<th scope="col">${ACCOUNTANT}</th>`);
    expect(html).not.toContain(SECRET);
  });

  it('échappe le contenu du modèle', () => {
    const trait = buildBusinessTrait({ code: 'TRT-60', text: '<script>alert(1)</script>' });
    const html = renderDossierHtml(build(withElements(buildCompleteModel(), [trait])));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
