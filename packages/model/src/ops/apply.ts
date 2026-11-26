import { isTempId, uuidv7 } from '../ids.js';
import type { BusinessModel } from '../schema/business-model.js';
import type { ChangeSet, ModelOp } from '../schema/change-set.js';
import { type Element, ElementSchema } from '../schema/element.js';
import { nextCode } from './codes.js';
import { checkCoherence } from './coherence.js';
import { deepEqual, diffModels } from './diff.js';
import { collectRefs, knownIds } from './refs.js';
import { transitionStatus, type TransitionContext } from './status.js';
import type {
  ApplyOptions,
  CoherenceIssue,
  IntegrityError,
  ModelDiff,
  StatusActor,
} from './types.js';

export type ApplyResult =
  | { ok: true; model: BusinessModel; diff: ModelDiff; warnings: CoherenceIssue[] }
  | { ok: false; errors: IntegrityError[] };

/** Options internes de `composeToBe` : version imposée, pas de contrôle de la base ni des créations. */
export interface InternalApplyOptions extends ApplyOptions {
  skipBaseCheck?: boolean;
  targetVersion?: number;
  trustedAdds?: boolean;
}

const EPOCH = '1970-01-01T00:00:00.000Z';
const IMMUTABLE = new Set(['id', 'kind', 'status', 'meta']);
/** Champs dont la modification n'est pas un changement de contenu (pas de retour de `validated`). */
const NON_CONTENT = new Set(['fieldProvenance', 'tags']);

type Obj = Record<string, unknown>;

/** Identifiants déterministes (UUID v7 bien formés) : empreinte FNV-1a de la mission et du rang. */
function deterministicIds(seed: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const bytes = new Uint8Array(10);
    let h = 0x811c9dc5;
    const text = `${seed}#${counter}`;
    for (let i = 0; i < bytes.length; i++) {
      for (let j = 0; j < text.length; j++) {
        h ^= text.charCodeAt(j) + i;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      bytes[i] = h & 0xff;
    }
    return uuidv7(0, bytes);
  };
}

/** Remplace récursivement les identifiants temporaires ; ignore le `changeSet` interne d'une optimisation. */
function mapTempIds(value: unknown, map: Map<string, string>, unknown_: Set<string>): unknown {
  if (typeof value === 'string') {
    if (!isTempId(value)) return value;
    const r = map.get(value);
    if (r === undefined) unknown_.add(value);
    return r ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => mapTempIds(v, map, unknown_));
  if (typeof value === 'object' && value !== null) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === 'changeSet' ? v : mapTempIds(v, map, unknown_);
    }
    return out;
  }
  return value;
}

function authorActor(el: Element): StatusActor {
  const t = el.provenance.author.type;
  return t === 'ai' ? 'ai' : t === 'system' ? 'system' : 'consultant';
}

/**
 * Applique un ChangeSet à un modèle. Fonction pure : produit un nouveau modèle (version + 1),
 * le diff et les avertissements de cohérence nouveaux, ou la liste des erreurs d'intégrité
 * (aucune opération n'est alors appliquée).
 */
export function applyChangeSet(
  model: BusinessModel,
  cs: ChangeSet,
  options: InternalApplyOptions = {},
): ApplyResult {
  const errors: IntegrityError[] = [];
  const err = (e: IntegrityError): void => {
    errors.push(e);
  };
  const newVersion = options.targetVersion ?? model.version + 1;
  const at = options.at ?? EPOCH;

  if (!options.skipBaseCheck && cs.baseVersion !== model.version) {
    return {
      ok: false,
      errors: [
        {
          code: 'STALE_BASE_VERSION',
          message: `Le ChangeSet part de la version ${cs.baseVersion}, le modèle est en version ${model.version}`,
        },
      ],
    };
  }

  // 1. Résolution des identifiants temporaires.
  const gen = options.newId ?? deterministicIds(`${model.missionId}:${model.version}`);
  const freshId = (used: (id: string) => boolean): string => {
    let id = gen();
    while (used(id)) id = gen();
    return id;
  };
  const tempMap = new Map<string, string>();
  const reserved = new Set<string>();
  cs.ops.forEach((op, opIndex) => {
    if (op.op !== 'add' || !isTempId(op.element.id)) return;
    if (tempMap.has(op.element.id)) {
      err({
        code: 'DUPLICATE_TEMP_ID',
        message: `Identifiant temporaire dupliqué : ${op.element.id}`,
        opIndex,
        elementId: op.element.id,
      });
      return;
    }
    const id = freshId((x) => x in model.elements || reserved.has(x));
    reserved.add(id);
    tempMap.set(op.element.id, id);
  });
  const unknownTemps = new Set<string>();
  const ops = mapTempIds(cs.ops, tempMap, unknownTemps) as ModelOp[];
  for (const t of unknownTemps) {
    err({
      code: 'UNKNOWN_TEMP_ID',
      message: `Identifiant temporaire non défini : ${t}`,
      targetId: t,
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  // 2. Application des opérations sur une copie de travail.
  const elements: Record<string, Element> = { ...model.elements };
  const rejected = [...model.rejectedHypotheses];
  const layout: BusinessModel['layout'] = { ...model.layout };
  const removedIds = new Set<string>();
  const codes = new Set(Object.values(elements).map((e) => e.code));

  const parse = (el: Element, opIndex: number): boolean => {
    const r = ElementSchema.safeParse(el);
    if (r.success) return true;
    for (const issue of r.error.issues) {
      err({
        code: 'SCHEMA_VIOLATION',
        message: issue.message,
        opIndex,
        elementId: el.id,
        path: issue.path.join('.'),
      });
    }
    return false;
  };

  const ctxFor = (
    actor: StatusActor,
    extra: Partial<TransitionContext> = {},
  ): TransitionContext => ({
    actor,
    at,
    ...(options.userId ? { userId: options.userId } : {}),
    ...(options.submissionId ? { submissionId: options.submissionId } : {}),
    ...extra,
  });

  ops.forEach((op, opIndex) => {
    switch (op.op) {
      case 'add': {
        const el = structuredClone(op.element) as Element;
        if (el.id in elements || removedIds.has(el.id)) {
          err({
            code: 'ID_COLLISION',
            message: `Identifiant déjà utilisé : ${el.id}`,
            opIndex,
            elementId: el.id,
          });
          return;
        }
        if (!options.trustedAdds) {
          const t = transitionStatus(
            null,
            el.status.value,
            ctxFor(authorActor(el), {
              hasVerifiedSource: el.provenance.refs.length > 0,
              hasRationale: el.provenance.rationale !== undefined,
            }),
          );
          if (!t.ok) {
            err({ code: 'FORBIDDEN_TRANSITION', message: t.message, opIndex, elementId: el.id });
            return;
          }
        }
        if (!el.code || codes.has(el.code)) {
          const parentId = el.kind === 'activity' ? el.parentId : undefined;
          const parentCode = parentId ? elements[parentId]?.code : undefined;
          (el as { code: string }).code = nextCode(el, codes, parentCode);
        }
        el.meta = { createdInVersion: newVersion, updatedInVersion: newVersion };
        if (!parse(el, opIndex)) return;
        codes.add(el.code);
        elements[el.id] = el;
        return;
      }
      case 'update': {
        const before = elements[op.id];
        if (!before) {
          err({
            code: 'UNKNOWN_ELEMENT',
            message: `Élément inconnu : ${op.id}`,
            opIndex,
            elementId: op.id,
          });
          return;
        }
        const touched = [...Object.keys(op.set), ...(op.unset ?? [])];
        const bad = touched.filter((k) => IMMUTABLE.has(k));
        if (bad.length > 0) {
          err({
            code: 'IMMUTABLE_FIELD',
            message: `Champ non modifiable par update : ${bad.join(', ')}`,
            opIndex,
            elementId: op.id,
            path: bad.join(','),
          });
          return;
        }
        const next = { ...(before as unknown as Obj) };
        for (const [k, v] of Object.entries(op.set)) next[k] = structuredClone(v);
        for (const k of op.unset ?? []) delete next[k];
        const changed = touched.filter((k) => !deepEqual((before as unknown as Obj)[k], next[k]));
        if (changed.length === 0) return;
        const nextEl = next as unknown as Element;
        if (typeof next.code === 'string' && next.code !== before.code && codes.has(next.code)) {
          err({
            code: 'DUPLICATE_CODE',
            message: `Code déjà utilisé : ${next.code}`,
            opIndex,
            elementId: op.id,
          });
          return;
        }
        if (before.status.value === 'validated' && changed.some((k) => !NON_CONTENT.has(k))) {
          const t = transitionStatus(
            before.status,
            'confirmed',
            ctxFor('system', { version: newVersion }),
          );
          if (t.ok && !t.rejected) nextEl.status = t.status;
        }
        nextEl.meta = { ...before.meta, updatedInVersion: newVersion };
        if (!parse(nextEl, opIndex)) return;
        if (nextEl.code !== before.code) {
          codes.delete(before.code);
          codes.add(nextEl.code);
        }
        elements[op.id] = nextEl;
        return;
      }
      case 'remove': {
        const ids = [op.id, ...(op.cascade ?? [])];
        const unknown = ids.filter((i) => !(i in elements));
        if (unknown.length > 0) {
          for (const u of unknown) {
            err({
              code: 'UNKNOWN_ELEMENT',
              message: `Élément inconnu : ${u}`,
              opIndex,
              elementId: u,
            });
          }
          return;
        }
        for (const i of ids) {
          codes.delete((elements[i] as Element).code);
          delete elements[i];
          removedIds.add(i);
        }
        return;
      }
      case 'set_status': {
        const before = elements[op.id];
        if (!before) {
          err({
            code: 'UNKNOWN_ELEMENT',
            message: `Élément inconnu : ${op.id}`,
            opIndex,
            elementId: op.id,
          });
          return;
        }
        const t = transitionStatus(
          before.status,
          op.status,
          ctxFor(options.actor ?? 'consultant', {
            version: newVersion,
            ...(op.correction !== undefined ? { correction: { previous: op.correction } } : {}),
          }),
        );
        if (!t.ok) {
          err({ code: 'FORBIDDEN_TRANSITION', message: t.message, opIndex, elementId: op.id });
          return;
        }
        if (t.rejected) return; // inatteignable : `op.status` n'est jamais « rejected »
        const nextEl = {
          ...before,
          status: t.status,
          meta: { ...before.meta, updatedInVersion: newVersion },
        } as Element;
        if (!parse(nextEl, opIndex)) return;
        elements[op.id] = nextEl;
        return;
      }
      case 'reject_hypothesis': {
        const before = elements[op.id];
        if (!before) {
          err({
            code: 'UNKNOWN_ELEMENT',
            message: `Élément inconnu : ${op.id}`,
            opIndex,
            elementId: op.id,
          });
          return;
        }
        if (before.status.value !== 'hypothesis') {
          err({
            code: 'NOT_A_HYPOTHESIS',
            message: `Seule une hypothèse peut être rejetée : ${op.id} est ${before.status.value}`,
            opIndex,
            elementId: op.id,
          });
          return;
        }
        const t = transitionStatus(
          before.status,
          'rejected',
          ctxFor(options.actor ?? 'consultant'),
        );
        if (!t.ok) {
          err({ code: 'FORBIDDEN_TRANSITION', message: t.message, opIndex, elementId: op.id });
          return;
        }
        rejected.push({
          element: before,
          by: options.userId ?? 'unknown',
          at,
          ...(op.reason !== undefined ? { reason: op.reason } : {}),
        });
        codes.delete(before.code);
        delete elements[op.id];
        removedIds.add(op.id);
        return;
      }
      case 'set_layout': {
        layout[op.diagram] = { ...(layout[op.diagram] ?? {}), ...structuredClone(op.positions) };
        return;
      }
    }
  });

  // 3. Intégrité référentielle : seules les références nouvellement cassées comptent.
  const baseKnown = knownIds(model);
  const baseBroken = new Set<string>();
  for (const el of Object.values(model.elements)) {
    for (const r of collectRefs(el)) {
      if (!baseKnown.has(r.targetId)) baseBroken.add(`${el.id}|${r.path}|${r.targetId}`);
    }
  }
  const next: BusinessModel = {
    ...model,
    version: newVersion,
    elements,
    rejectedHypotheses: rejected,
    layout,
  };
  const nextKnown = knownIds(next);
  for (const el of Object.values(elements)) {
    for (const r of collectRefs(el)) {
      if (nextKnown.has(r.targetId) || baseBroken.has(`${el.id}|${r.path}|${r.targetId}`)) continue;
      const wasRemoved = removedIds.has(r.targetId);
      err({
        code: wasRemoved ? 'REFERENCED_ELEMENT' : 'UNKNOWN_REFERENCE',
        message: wasRemoved
          ? `${r.targetId} ne peut pas être retiré : « ${el.label} » (${r.path}) le référence encore`
          : `Référence inconnue : ${r.targetId} (${el.label}, ${r.path})`,
        elementId: el.id,
        path: r.path,
        targetId: r.targetId,
      });
    }
  }
  for (const [diagram, boxes] of Object.entries(layout)) {
    if (deepEqual(boxes, model.layout[diagram])) continue;
    for (const id of Object.keys(boxes)) {
      if (!nextKnown.has(id)) {
        if (removedIds.has(id)) delete boxes[id];
        else {
          err({
            code: 'UNKNOWN_REFERENCE',
            message: `Disposition de ${diagram} : élément inconnu ${id}`,
            elementId: id,
            path: `layout.${diagram}`,
            targetId: id,
          });
        }
      }
    }
  }
  // Disposition des éléments retirés dans les diagrammes non modifiés par ce ChangeSet.
  for (const [diagram, boxes] of Object.entries(layout)) {
    if (boxes === model.layout[diagram] && Object.keys(boxes).some((id) => removedIds.has(id))) {
      layout[diagram] = Object.fromEntries(
        Object.entries(boxes).filter(([id]) => !removedIds.has(id)),
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const diff = diffModels(model, next);
  const before = new Set(checkCoherence(model).map((i) => `${i.code}|${i.elementId}`));
  const warnings = checkCoherence(next).filter((i) => !before.has(`${i.code}|${i.elementId}`));
  return { ok: true, model: next, diff, warnings };
}
