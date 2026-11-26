import { beforeEach, describe, expect, it } from 'vitest';
import { isUuidV7, sequentialIdGenerator } from '../ids.js';
import type { ChangeSet, ModelOp } from '../schema/change-set.js';
import {
  buildActivity,
  buildActor,
  buildDataField,
  buildDataObject,
  buildRule,
  buildGlossaryTerm,
  buildModel,
  buildProvenance,
  buildStatus,
  buildMinimalModel,
  resetTestIds,
} from '../testing/index.js';
import { applyChangeSet } from './apply.js';
import { parseModel } from '../parse.js';
import type { ApplyResult } from './apply.js';
import type { IntegrityErrorCode } from './types.js';

const cs = (ops: ModelOp[], baseVersion = 1): ChangeSet => ({
  baseVersion,
  ops,
  cause: 'dialogue_edit',
  summary: 'Test',
});
const AT = '2026-03-01T08:00:00.000Z';
const OPTS = { at: AT, userId: 'u1', newId: sequentialIdGenerator(9) };

function errorCodes(r: ApplyResult): IntegrityErrorCode[] {
  if (r.ok) throw new Error('résultat inattendu : ok');
  return r.errors.map((e) => e.code);
}

describe('applyChangeSet', () => {
  beforeEach(() => resetTestIds());

  it('incrémente la version et rend un modèle valide', () => {
    const m = buildMinimalModel();
    const actor = buildActor({ label: 'Nouveau', code: '' });
    const r = applyChangeSet(m, cs([{ op: 'add', element: { ...actor, id: 'tmp:1' } }]), OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model.version).toBe(m.version + 1);
    expect(parseModel(JSON.parse(JSON.stringify(r.model))).ok).toBe(true);
    expect(r.diff.added).toHaveLength(1);
  });

  it('refuse un ChangeSet dont la base est périmée', () => {
    const m = buildMinimalModel();
    expect(errorCodes(applyChangeSet(m, cs([], 7), OPTS))).toEqual(['STALE_BASE_VERSION']);
  });

  describe('identifiants temporaires', () => {
    it('résout tmp:n dans l’élément et dans les références des opérations suivantes', () => {
      const m = buildMinimalModel();
      const macro = Object.values(m.elements).find(
        (e) => e.kind === 'activity' && e.level === 'macro',
      );
      const actor = buildActor({ code: '' });
      const process = buildActivity({
        level: 'process',
        code: '',
        parentId: macro?.id as string,
        responsibleActorId: 'tmp:1',
      });
      const r = applyChangeSet(
        m,
        cs([
          { op: 'add', element: { ...actor, id: 'tmp:1' } },
          { op: 'add', element: { ...process, id: 'tmp:2' } },
          { op: 'update', id: 'tmp:2', set: { label: 'Renommé' } },
        ]),
        OPTS,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const added = r.diff.added;
      expect(added).toHaveLength(2);
      expect(added.every(isUuidV7)).toBe(true);
      const created =
        r.model.elements[added.find((id) => r.model.elements[id]?.kind === 'activity') as string];
      expect(created).toMatchObject({ label: 'Renommé' });
      expect(JSON.stringify(added.map((id) => r.model.elements[id]))).not.toContain('tmp:');
    });

    it('refuse un identifiant temporaire jamais défini', () => {
      const m = buildMinimalModel();
      const a = buildActivity({ level: 'macro', code: '', inputs: ['tmp:99'] });
      const r = applyChangeSet(m, cs([{ op: 'add', element: { ...a, id: 'tmp:1' } }]), OPTS);
      expect(errorCodes(r)).toEqual(['UNKNOWN_TEMP_ID']);
    });

    it('refuse un identifiant temporaire dupliqué', () => {
      const m = buildMinimalModel();
      const a = buildActor({ code: '' });
      const b = buildActor({ code: '' });
      const r = applyChangeSet(
        m,
        cs([
          { op: 'add', element: { ...a, id: 'tmp:1' } },
          { op: 'add', element: { ...b, id: 'tmp:1' } },
        ]),
        OPTS,
      );
      expect(errorCodes(r)).toContain('DUPLICATE_TEMP_ID');
    });

    it('sans générateur fourni, les identifiants sont déterministes', () => {
      const m = buildMinimalModel();
      const op: ModelOp = { op: 'add', element: { ...buildActor({ code: '' }), id: 'tmp:1' } };
      const a = applyChangeSet(m, cs([op]));
      const b = applyChangeSet(m, cs([op]));
      expect(a).toEqual(b);
      expect(a.ok && a.diff.added.every(isUuidV7)).toBe(true);
    });
  });

  describe('attribution des codes', () => {
    const codeOf = (r: ApplyResult, i = 0): string => {
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      return (r.model.elements[r.diff.added[i] as string] as { code: string }).code;
    };
    it.each([
      ['acteur', () => buildActor({ code: '' }), /^ACT-\d{2}$/],
      ['règle', () => buildRule({ code: '' }), /^RG-\d{3}$/],
      ['objet de donnée', () => buildDataObject({ code: '' }), /^DON-\d{2}$/],
    ])('%s sans code reçoit un code au format attendu', (_n, make, re) => {
      const r = applyChangeSet(
        buildModel([]),
        cs([{ op: 'add', element: { ...make(), id: 'tmp:1' } }]),
        OPTS,
      );
      expect(codeOf(r)).toMatch(re);
    });

    it('un code déjà pris est remplacé par le suivant libre', () => {
      const existing = buildActor({ code: 'ACT-01' });
      const m = buildModel([existing]);
      const r = applyChangeSet(
        m,
        cs([{ op: 'add', element: { ...buildActor({ code: 'ACT-01' }), id: 'tmp:1' } }]),
        OPTS,
      );
      expect(codeOf(r)).toBe('ACT-02');
    });

    it('un code libre fourni est conservé', () => {
      const r = applyChangeSet(
        buildModel([]),
        cs([{ op: 'add', element: { ...buildActor({ code: 'ACT-42' }), id: 'tmp:1' } }], 1),
        OPTS,
      );
      expect(codeOf(r)).toBe('ACT-42');
    });

    it('codes hiérarchiques : macro P01, processus P01.1, tâche P01.1.1', () => {
      const r = applyChangeSet(
        buildModel([]),
        cs([
          { op: 'add', element: { ...buildActivity({ level: 'macro', code: '' }), id: 'tmp:1' } },
          {
            op: 'add',
            element: {
              ...buildActivity({ level: 'process', code: '', parentId: 'tmp:1' }),
              id: 'tmp:2',
            },
          },
          {
            op: 'add',
            element: {
              ...buildActivity({ level: 'task', code: '', parentId: 'tmp:2' }),
              id: 'tmp:3',
            },
          },
          {
            op: 'add',
            element: {
              ...buildActivity({ level: 'process', code: '', parentId: 'tmp:1' }),
              id: 'tmp:4',
            },
          },
        ]),
        OPTS,
      );
      expect([0, 1, 2, 3].map((i) => codeOf(r, i)).sort()).toEqual([
        'P01',
        'P01.1',
        'P01.1.1',
        'P01.2',
      ]);
    });
  });

  describe('intégrité référentielle', () => {
    it('refuse la suppression d’un élément référencé', () => {
      const m = buildMinimalModel();
      const accountant = Object.values(m.elements).find(
        (e) => e.kind === 'actor' && e.label === 'Comptable',
      );
      const r = applyChangeSet(m, cs([{ op: 'remove', id: accountant?.id as string }]), OPTS);
      expect(errorCodes(r)).toContain('REFERENCED_ELEMENT');
      if (!r.ok) expect(r.errors[0]?.targetId).toBe(accountant?.id);
    });

    it('accepte la suppression si les référents sont supprimés en cascade', () => {
      const actor = buildActor();
      const act = buildActivity({ responsibleActorId: actor.id });
      const m = buildModel([actor, act]);
      const r = applyChangeSet(m, cs([{ op: 'remove', id: actor.id, cascade: [act.id] }]), OPTS);
      expect(r.ok).toBe(true);
      if (r.ok) expect(Object.keys(r.model.elements)).toEqual([]);
    });

    it('accepte la suppression si le ChangeSet retire aussi la référence', () => {
      const actor = buildActor();
      const act = buildActivity({ responsibleActorId: actor.id });
      const m = buildModel([actor, act]);
      const r = applyChangeSet(
        m,
        cs([
          { op: 'remove', id: actor.id },
          { op: 'update', id: act.id, set: {}, unset: ['responsibleActorId'] },
        ]),
        OPTS,
      );
      expect(r.ok).toBe(true);
    });

    it('refuse une référence vers un élément inconnu', () => {
      const act = buildActivity();
      const m = buildModel([act]);
      const r = applyChangeSet(
        m,
        cs([
          {
            op: 'update',
            id: act.id,
            set: { responsibleActorId: '01900000-0000-7000-8000-0000000000aa' },
          },
        ]),
        OPTS,
      );
      expect(errorCodes(r)).toEqual(['UNKNOWN_REFERENCE']);
    });

    it('n’impute pas au ChangeSet les références déjà cassées dans la base', () => {
      const act = buildActivity({ inputs: ['01900000-0000-7000-8000-0000000000bb'] });
      const m = buildModel([act]);
      const r = applyChangeSet(m, cs([{ op: 'update', id: act.id, set: { label: 'x' } }]), OPTS);
      expect(r.ok).toBe(true);
    });

    it('refuse la suppression d’un élément inconnu', () => {
      const r = applyChangeSet(
        buildModel([]),
        cs([{ op: 'remove', id: '01900000-0000-7000-8000-0000000000cc' }]),
        OPTS,
      );
      expect(errorCodes(r)).toEqual(['UNKNOWN_ELEMENT']);
    });

    it('accepte une référence vers un champ de donnée', () => {
      const field = buildDataField();
      const dobj = buildDataObject({ fields: [field] });
      const rule = buildRule();
      const r = applyChangeSet(
        buildModel([dobj, rule]),
        cs([{ op: 'update', id: rule.id, set: { appliesTo: [field.id] } }]),
        OPTS,
      );
      expect(r.ok).toBe(true);
    });

    it('retire la disposition d’un élément supprimé', () => {
      const a = buildActor();
      const m = buildModel([a], { layout: { L0: { [a.id]: { x: 0, y: 0, w: 1, h: 1 } } } });
      const r = applyChangeSet(m, cs([{ op: 'remove', id: a.id }]), OPTS);
      expect(r.ok && r.model.layout.L0).toEqual({});
    });
  });

  describe('update', () => {
    it.each(['id', 'kind', 'status', 'meta'])('refuse de modifier %s', (field) => {
      const a = buildActor();
      const r = applyChangeSet(
        buildModel([a]),
        cs([{ op: 'update', id: a.id, set: { [field]: 'x' } }]),
        OPTS,
      );
      expect(errorCodes(r)).toEqual(['IMMUTABLE_FIELD']);
    });

    it('refuse un code déjà pris', () => {
      const a = buildActor({ code: 'ACT-01' });
      const b = buildActor({ code: 'ACT-02' });
      const r = applyChangeSet(
        buildModel([a, b]),
        cs([{ op: 'update', id: b.id, set: { code: 'ACT-01' } }]),
        OPTS,
      );
      expect(errorCodes(r)).toEqual(['DUPLICATE_CODE']);
    });

    it('refuse un résultat qui viole le schéma', () => {
      const a = buildActor();
      const r = applyChangeSet(
        buildModel([a]),
        cs([{ op: 'update', id: a.id, set: { category: 'bogus' } }]),
        OPTS,
      );
      expect(errorCodes(r)).toEqual(['SCHEMA_VIOLATION']);
    });

    it('met à jour meta.updatedInVersion ; une mise à jour sans effet ne touche à rien', () => {
      const a = buildActor();
      const m = buildModel([a]);
      const noop = applyChangeSet(
        m,
        cs([{ op: 'update', id: a.id, set: { label: a.label } }]),
        OPTS,
      );
      expect(noop.ok && noop.diff.modified).toEqual([]);
      const r = applyChangeSet(m, cs([{ op: 'update', id: a.id, set: { label: 'Autre' } }]), OPTS);
      expect(r.ok && r.model.elements[a.id]?.meta).toEqual({
        createdInVersion: 1,
        updatedInVersion: 2,
      });
      expect(r.ok && r.diff.modified).toEqual([{ id: a.id, fields: ['label'] }]);
    });

    it('un élément validé modifié repasse à confirmed avec changedAfterValidation', () => {
      const a = buildActor({
        status: buildStatus({ value: 'validated', validatedInSubmission: 's1' }),
      });
      const r = applyChangeSet(
        buildModel([a]),
        cs([{ op: 'update', id: a.id, set: { label: 'Modifié' } }]),
        OPTS,
      );
      expect(r.ok && r.model.elements[a.id]?.status).toMatchObject({
        value: 'confirmed',
        changedAfterValidation: { version: 2, at: AT },
      });
    });

    it('un changement sans contenu (tags) laisse l’élément validé', () => {
      const a = buildActor({
        status: buildStatus({ value: 'validated', validatedInSubmission: 's1' }),
      });
      const r = applyChangeSet(
        buildModel([a]),
        cs([{ op: 'update', id: a.id, set: { tags: ['x'] } }]),
        OPTS,
      );
      expect(r.ok && r.model.elements[a.id]?.status.value).toBe('validated');
    });
  });

  describe('statuts', () => {
    it('set_status applique la matrice', () => {
      const a = buildActor({
        status: buildStatus({ value: 'extracted' }),
        provenance: buildProvenance({
          origin: 'document',
          refs: [
            {
              sourceId: '01900000-ffff-7000-8000-000000000001',
              sourceRevision: 1,
              locator: { charStart: 0, charEnd: 1 },
              quote: 'q',
            },
          ],
        }),
      });
      const m = buildModel([a]);
      const ok = applyChangeSet(m, cs([{ op: 'set_status', id: a.id, status: 'confirmed' }]), OPTS);
      expect(ok.ok && ok.model.elements[a.id]?.status).toMatchObject({
        value: 'confirmed',
        decidedBy: 'u1',
        decidedAt: AT,
      });
      const forbidden = applyChangeSet(
        m,
        cs([{ op: 'set_status', id: a.id, status: 'validated' }]),
        OPTS,
      );
      expect(errorCodes(forbidden)).toEqual(['FORBIDDEN_TRANSITION']);
      const validated = applyChangeSet(
        m,
        cs([{ op: 'set_status', id: a.id, status: 'validated' }]),
        {
          ...OPTS,
          actor: 'validator',
          submissionId: 'sub-1',
        },
      );
      expect(validated.ok && validated.model.elements[a.id]?.status.validatedInSubmission).toBe(
        'sub-1',
      );
    });

    it('une IA ne peut pas créer un élément confirmé', () => {
      const a = buildActor({ provenance: buildProvenance({ author: { type: 'ai' } }) });
      const r = applyChangeSet(buildModel([]), cs([{ op: 'add', element: a }], 1), OPTS);
      expect(errorCodes(r)).toEqual(['FORBIDDEN_TRANSITION']);
    });

    it('reject_hypothesis archive l’hypothèse', () => {
      const h = buildGlossaryTerm({
        status: buildStatus({ value: 'hypothesis' }),
        provenance: buildProvenance({
          origin: 'ai_knowledge',
          rationale: 'usage',
          author: { type: 'ai' },
        }),
      });
      const m = buildModel([h]);
      const r = applyChangeSet(
        m,
        cs([{ op: 'reject_hypothesis', id: h.id, reason: 'Hors périmètre' }]),
        OPTS,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.model.elements[h.id]).toBeUndefined();
      expect(r.model.rejectedHypotheses).toEqual([
        { element: h, by: 'u1', at: AT, reason: 'Hors périmètre' },
      ]);
    });

    it('reject_hypothesis refuse un élément qui n’est pas une hypothèse', () => {
      const a = buildActor();
      const r = applyChangeSet(buildModel([a]), cs([{ op: 'reject_hypothesis', id: a.id }]), OPTS);
      expect(errorCodes(r)).toEqual(['NOT_A_HYPOTHESIS']);
    });
  });

  it('set_layout fusionne les positions ; une position pour un inconnu est refusée', () => {
    const a = buildActor();
    const m = buildModel([a]);
    const ok = applyChangeSet(
      m,
      cs([{ op: 'set_layout', diagram: 'L0', positions: { [a.id]: { x: 1, y: 2, w: 3, h: 4 } } }]),
      OPTS,
    );
    expect(ok.ok && ok.diff.layout).toEqual(['L0']);
    const bad = applyChangeSet(
      m,
      cs([
        {
          op: 'set_layout',
          diagram: 'L0',
          positions: { '01900000-0000-7000-8000-0000000000dd': { x: 1, y: 2, w: 3, h: 4 } },
        },
      ]),
      OPTS,
    );
    expect(errorCodes(bad)).toEqual(['UNKNOWN_REFERENCE']);
  });

  it('est atomique : une erreur n’applique rien et le modèle d’entrée est intact', () => {
    const a = buildActor();
    const m = buildModel([a]);
    const before = structuredClone(m);
    const r = applyChangeSet(
      m,
      cs([
        { op: 'update', id: a.id, set: { label: 'ok' } },
        { op: 'remove', id: '01900000-0000-7000-8000-0000000000ee' },
      ]),
      OPTS,
    );
    expect(r.ok).toBe(false);
    expect(m).toEqual(before);
  });

  it('remonte en avertissements les incohérences nouvelles seulement', () => {
    const process = buildActivity({ level: 'process', parentId: undefined, label: 'P' });
    const m = buildModel([buildActivity({ level: 'macro' })]);
    const r = applyChangeSet(
      m,
      cs([
        {
          op: 'add',
          element: {
            ...process,
            id: 'tmp:1',
            parentId: Object.keys(m.elements)[0] as string,
            code: '',
          },
        },
      ]),
      OPTS,
    );
    expect(r.ok && r.warnings.map((w) => w.code)).toEqual(['ACTIVITY_WITHOUT_OWNER']);
  });
});
