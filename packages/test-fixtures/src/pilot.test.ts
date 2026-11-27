import { describe, expect, it } from 'vitest';
import {
  PILOT_ACTORS,
  PILOT_CONTRADICTORY_DOCUMENT,
  PILOT_DESCRIPTION,
  PILOT_MACROS,
  PILOT_SCANNED_DOCUMENT_NAME,
  PILOT_STAKEHOLDERS,
  pilotDocumentVisualScenario,
  pilotExtractionChunkScenario,
  pilotReconcileScenario,
} from './pilot.js';

const chunkRequest = (text: string) => ({
  messages: [
    { role: 'user', content: `<morceau id="m1" source="Description">\n${text}\n</morceau>` },
  ],
});

describe('scénario du pilote (CDC 8)', () => {
  it('couvre les 14 macroprocessus P01 à P14, 8 acteurs et 4 parties prenantes', () => {
    expect(PILOT_MACROS.map((m) => m.code)).toEqual(
      Array.from({ length: 14 }, (_v, i) => `P${String(i + 1).padStart(2, '0')}`),
    );
    expect(PILOT_ACTORS).toHaveLength(8);
    expect(PILOT_STAKEHOLDERS).toHaveLength(4);
    // Couverture du CDC 8.2 : P03 à P11 dans l'application, les autres cartographiés.
    for (const m of PILOT_MACROS) {
      const n = Number(m.code.slice(1));
      expect(m.scope).toBe(n >= 3 && n <= 11 ? 'application' : 'mapping_only');
    }
  });

  it('chaque citation scriptée est une sous-chaîne exacte du texte', () => {
    const out = pilotExtractionChunkScenario(chunkRequest(PILOT_DESCRIPTION)) as {
      candidates: { quote: string; label: string }[];
    };
    const activities = PILOT_MACROS.reduce((n, m) => n + m.activities.length, 0);
    // 14 macros + activités + 12 acteurs + 2 outils + 2 traits du métier + 3 traits du flux.
    expect(out.candidates).toHaveLength(14 + activities + 12 + 2 + 2 + 3);
    const text = PILOT_DESCRIPTION.toLowerCase();
    for (const c of out.candidates) expect(text).toContain(c.quote.toLowerCase());
  });

  it('le second document ne produit que l’affirmation contradictoire', () => {
    const out = pilotExtractionChunkScenario(chunkRequest(PILOT_CONTRADICTORY_DOCUMENT)) as {
      candidates: { label: string; activity: { responsible: string } }[];
    };
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]?.label).toBe('Relances clients');
    expect(out.candidates[0]?.activity.responsible).toBe('Collaborateur comptable');
  });

  it('réconcilie : un écart quand deux responsables différents sont désignés', () => {
    const existing = {
      code: 'P04.2',
      kind: 'activity',
      label: 'Relances clients',
      level: 'process',
      responsible: 'Assistant administratif',
    };
    const data = {
      candidates: [
        {
          ref: '0:c1',
          kind: 'activity',
          label: 'Relances clients',
          level: 'process',
          responsible: 'Collaborateur comptable',
        },
      ],
      known: [{ candidateRef: '0:c1', existingCode: 'P04.2' }],
      model: [existing],
    };
    const ask = (payload: unknown) =>
      pilotReconcileScenario({
        messages: [{ role: 'user', content: `<donnees>\n${JSON.stringify(payload)}\n</donnees>` }],
      }) as { discrepancies: { existingCode: string }[] };
    const out = ask(data);
    expect(out.discrepancies).toHaveLength(1);
    expect(out.discrepancies[0]?.existingCode).toBe('P04.2');
    const same = ask({ ...data, model: [{ ...existing, responsible: 'Collaborateur comptable' }] });
    expect(same.discrepancies).toHaveLength(0);
  });

  it('transcrit le PDF scanné du pilote', () => {
    const out = pilotDocumentVisualScenario({
      messages: [],
      attachments: [{ name: PILOT_SCANNED_DOCUMENT_NAME }],
    }) as { pages: { text: string }[] };
    expect(out.pages[0]?.text).toBe(PILOT_CONTRADICTORY_DOCUMENT);
  });
});
