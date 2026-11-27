import { Inject, Injectable } from '@nestjs/common';
import type { Correction, DecisionRequest, DecisionResult } from '@processia/contracts';
import {
  planHypothesisRejection,
  type BusinessModel,
  type ChangeSet,
  type Element,
  type ModelOp,
  type StatusActor,
} from '@processia/model';
import { AuthError } from '../auth/errors.js';
import { ModelService } from '../model/model.service.js';
import type { MissionContext } from '../policy/mission-context.js';

/** Attributs textuels corrigeables par formulaire, par nature d'élément d'analyse [PO-5]. */
export const CORRECTABLE_FIELDS: Partial<Record<Element['kind'], (keyof Correction)[]>> = {
  business_trait: ['label', 'description', 'text'],
  glossary_term: ['label', 'description', 'definition'],
  actor: ['label', 'description', 'responsibilities'],
  activity: ['label', 'description'],
  tool: ['label', 'description'],
};

const MAX_ATTEMPTS = 3;

function alreadyDecided(): AuthError {
  return new AuthError('CONFLICT', { reason: 'ALREADY_DECIDED' });
}

/**
 * Décisions du consultant sur les éléments `extracted` et `hypothesis` (CDC 3.1) : confirmer,
 * corriger ou rejeter. Chaque décision est un petit ChangeSet de cause `hypothesis_decision`.
 * Deux consultants qui décident le même élément : le second reçoit 409 `ALREADY_DECIDED`.
 */
@Injectable()
export class DecisionsService {
  constructor(@Inject(ModelService) private readonly models: ModelService) {}

  async decide(
    ctx: MissionContext,
    userId: string,
    elementId: string,
    request: DecisionRequest,
  ): Promise<DecisionResult> {
    const actor: StatusActor = ctx.missionRole === 'manager' ? 'mission_lead' : 'consultant';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await ctx.run(async (tx) => {
          const { model } = await this.models.getModel(tx, ctx.missionId);
          const changeSet = this.buildChangeSet(model, elementId, request, userId);
          const committed = await this.models.commitInTx(tx, ctx.missionId, changeSet, {
            userId,
            actor,
          });
          return {
            version: committed.version,
            outcome: request.decision === 'reject' ? 'rejected' : 'confirmed',
          } satisfies DecisionResult;
        });
      } catch (error) {
        // Le modèle a avancé pendant la décision : on la rejuge sur la nouvelle tête. Si
        // l'élément a été décidé entre-temps, `buildChangeSet` répond « déjà décidé ».
        const retry =
          error instanceof AuthError &&
          (error.code === 'STALE' || error.code === 'CHANGESET_INVALID');
        if (!retry || attempt === MAX_ATTEMPTS) throw error;
      }
    }
    throw alreadyDecided();
  }

  private buildChangeSet(
    model: BusinessModel,
    elementId: string,
    request: DecisionRequest,
    userId: string,
  ): ChangeSet {
    const element = model.elements[elementId];
    if (element === undefined) {
      // Une hypothèse rejetée n'est plus dans le modèle : un second rejet est « déjà décidé ».
      if (model.rejectedHypotheses.some((r) => r.element.id === elementId)) throw alreadyDecided();
      throw new AuthError('NOT_FOUND');
    }
    const status = element.status.value;
    if (status !== 'extracted' && status !== 'hypothesis') throw alreadyDecided();
    if (element.kind === 'discrepancy') {
      throw new AuthError('VALIDATION_ERROR', [
        { path: 'elementId', message: 'Un écart se résout, il ne se confirme pas.' },
      ]);
    }
    const label = `${element.code} « ${element.label} »`;
    const ops: ModelOp[] = [];
    let summary: string;
    switch (request.decision) {
      case 'accept': {
        const fieldsOp = this.confirmFields(element, userId);
        if (fieldsOp !== null) ops.push(fieldsOp);
        ops.push({ op: 'set_status', id: elementId, status: 'confirmed' });
        summary = `Confirmation de ${label}`;
        break;
      }
      case 'reject': {
        if (status !== 'hypothesis') {
          throw new AuthError('VALIDATION_ERROR', [
            { path: 'decision', message: 'Seule une hypothèse peut être rejetée.' },
          ]);
        }
        // Les hypothèses qui ne survivent pas à ce rejet (un flux de séquence dont on rejette un
        // nœud, par exemple) sont rejetées avec lui ; les références facultatives sont nettoyées.
        const plan = planHypothesisRejection(model, [elementId]);
        if (!plan.ok) {
          throw new AuthError(
            'VALIDATION_ERROR',
            plan.blockedBy.map((b) => ({
              path: 'decision',
              message: `« ${b.code} ${b.label} » est déjà décidé et référence cet élément.`,
            })),
          );
        }
        for (const update of plan.updates) {
          ops.push({
            op: 'update',
            id: update.id,
            set: update.set,
            ...(update.unset.length === 0 ? {} : { unset: update.unset }),
          });
        }
        const reason =
          request.reason === undefined || request.reason === '' ? {} : { reason: request.reason };
        for (const id of plan.reject) {
          ops.push({ op: 'reject_hypothesis', id, ...(id === elementId ? reason : {}) });
        }
        summary =
          plan.reject.length > 1
            ? `Rejet de l’hypothèse ${label} et de ${plan.reject.length - 1} élément(s) liés`
            : `Rejet de l’hypothèse ${label}`;
        break;
      }
      case 'correct': {
        const { set, unset, previous } = this.applyCorrection(element, request.correction);
        ops.push({
          op: 'update',
          id: elementId,
          set,
          ...(unset.length === 0 ? {} : { unset }),
        });
        ops.push({ op: 'set_status', id: elementId, status: 'confirmed', correction: previous });
        summary = `Correction et confirmation de ${label}`;
        break;
      }
    }
    return { baseVersion: model.version, ops, cause: 'hypothesis_decision', summary };
  }

  /**
   * Les champs d'un objet de données portent leur propre statut : confirmer l'objet confirme ses
   * champs encore hypothétiques (sinon la vue des livrables les retirerait). `null` : rien à faire.
   */
  confirmFields(element: Element, userId: string): ModelOp | null {
    if (element.kind !== 'data_object') return null;
    if (!element.fields.some((f) => f.status.value === 'hypothesis')) return null;
    return {
      op: 'update',
      id: element.id,
      set: {
        fields: element.fields.map((f) =>
          f.status.value === 'hypothesis'
            ? { ...f, status: { value: 'confirmed', decidedBy: userId } }
            : f,
        ),
      },
    };
  }

  /** Valeurs à écrire et valeurs précédentes (conservées dans `status.correction`). */
  private applyCorrection(
    element: Element,
    correction: Correction,
  ): { set: Record<string, unknown>; unset: string[]; previous: Record<string, unknown> } {
    const allowed = CORRECTABLE_FIELDS[element.kind];
    const current = element as unknown as Record<string, unknown>;
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    const previous: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(correction) as [keyof Correction, unknown][]) {
      if (value === undefined) continue;
      if (allowed === undefined || !allowed.includes(field)) {
        throw new AuthError('VALIDATION_ERROR', [
          {
            path: `correction.${field}`,
            message: 'Cet attribut ne se corrige pas par formulaire.',
          },
        ]);
      }
      if (JSON.stringify(current[field]) === JSON.stringify(value)) continue;
      // Une description vidée se retire du modèle au lieu de rester une chaîne vide.
      if (value === '') unset.push(field);
      else set[field] = value;
      previous[field] = current[field] ?? null;
    }
    if (Object.keys(set).length === 0 && unset.length === 0) {
      throw new AuthError('VALIDATION_ERROR', [
        { path: 'correction', message: 'Aucune valeur n’a changé : confirmez plutôt l’élément.' },
      ]);
    }
    return { set, unset, previous };
  }
}
