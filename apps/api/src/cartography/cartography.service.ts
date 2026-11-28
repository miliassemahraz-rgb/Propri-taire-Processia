import { Inject, Injectable, Logger } from '@nestjs/common';
import { toBpmn } from '@processia/bpmn';
import type { BpmnDiagramDto } from '@processia/contracts';
import { listDiagrams, type ModelOp, type StatusActor } from '@processia/model';
import { AuthError } from '../auth/errors.js';
import { ModelService } from '../model/model.service.js';
import type { MissionContext } from '../policy/mission-context.js';

/** Nombre maximal de BPMN gardés en mémoire (un par version et par diagramme). */
const CACHE_LIMIT = 200;

/**
 * Production du BPMN des diagrammes pour la visionneuse (WP-19, ADR 0026). Le XML est calculé par
 * `toBpmn` (WP-18) à partir du modèle de la version demandée, puis gardé en mémoire par version
 * et par diagramme : le même modèle donne toujours le même XML, le cache n'est qu'un gain de temps.
 *
 * Les positions nouvelles (`layoutOps`) sont enregistrées une fois, dans une version de cause
 * `layout`, seulement pour la tête et seulement par un membre de l'équipe qui peut écrire : un
 * nouveau rendu réutilise alors les positions des éléments inchangés (stabilité, ADR 0013). Une
 * lecture d'une version passée ne crée jamais de version.
 */
@Injectable()
export class CartographyService {
  private readonly log = new Logger(CartographyService.name);
  private readonly cache = new Map<string, string>();
  /** Écritures de disposition d'une mission : une à la fois, pour ne pas créer deux versions. */
  private readonly layoutLocks = new Map<string, Promise<unknown>>();

  constructor(@Inject(ModelService) private readonly models: ModelService) {}

  async diagram(
    ctx: MissionContext,
    userId: string,
    diagram: string,
    requestedVersion: number | undefined,
  ): Promise<BpmnDiagramDto> {
    const { version, model } = await ctx.run((tx) =>
      this.models.getModel(tx, ctx.missionId, requestedVersion),
    );
    if (version === 0 || !listDiagrams(model).includes(diagram)) {
      throw new AuthError('NOT_FOUND');
    }
    const key = `${ctx.missionId}:${version}:${diagram}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return { diagram, version, xml: cached };

    const { xml, layoutOps } = await toBpmn(model, diagram);
    this.remember(key, xml);

    const isHead = requestedVersion === undefined;
    const canWrite = ctx.missionRole === 'manager' || ctx.missionRole === 'consultant';
    if (isHead && canWrite && layoutOps.length > 0) {
      await this.saveLayout(ctx, userId, diagram, layoutOps);
    }
    return { diagram, version, xml };
  }

  private remember(key: string, xml: string): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, xml);
  }

  /** Enregistre les positions nouvelles ; un échec (version en retard, par exemple) est sans suite. */
  private saveLayout(
    ctx: MissionContext,
    userId: string,
    diagram: string,
    ops: ModelOp[],
  ): Promise<void> {
    const previous = this.layoutLocks.get(ctx.missionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          const actor: StatusActor = ctx.missionRole === 'manager' ? 'mission_lead' : 'consultant';
          await ctx.run(async (tx) => {
            // Une autre requête a pu enregistrer les mêmes positions entre-temps : ne garder que le nouveau.
            const head = await this.models.getModel(tx, ctx.missionId);
            const stored = head.model.layout[diagram] ?? {};
            const fresh: ModelOp[] = [];
            for (const op of ops) {
              if (op.op !== 'set_layout') continue;
              const positions = Object.fromEntries(
                Object.entries(op.positions).filter(([id, box]) => {
                  const s = stored[id];
                  return !s || s.x !== box.x || s.y !== box.y || s.w !== box.w || s.h !== box.h;
                }),
              );
              if (Object.keys(positions).length > 0) {
                fresh.push({ op: 'set_layout', diagram: op.diagram, positions });
              }
            }
            if (fresh.length === 0) return;
            await this.models.commitInTx(
              tx,
              ctx.missionId,
              {
                baseVersion: head.version,
                ops: fresh,
                cause: 'layout',
                summary: `Disposition du diagramme ${diagram}`,
              },
              { userId, actor },
            );
          });
        } catch (error) {
          this.log.warn(
            `Disposition non enregistrée (mission ${ctx.missionId}, ${diagram}) : ${String(error)}`,
          );
        }
      });
    this.layoutLocks.set(ctx.missionId, next);
    return next.finally(() => {
      if (this.layoutLocks.get(ctx.missionId) === next) this.layoutLocks.delete(ctx.missionId);
    });
  }
}
