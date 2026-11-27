import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AiError,
  buildProcessFlowChangeSet,
  buildProcessFlowInput,
  flowScopeHypotheses,
  hasProcessFlow,
  hasTaskDetail,
  listFlowProcesses,
  processFlowPipeline,
  type FakeScenario,
} from '@processia/ai';
import {
  FLOW_RUN_KIND,
  type FlowDecisionRequest,
  type FlowDecisionResult,
  type FlowFailureDto,
  type FlowOverviewDto,
  type StartFlowRequest,
  type StartFlowResult,
} from '@processia/contracts';
import { analysisRuns, withMission, type Database } from '@processia/db';
import {
  planHypothesisRejection,
  uuidv7,
  type BusinessModel,
  type ChangeSet,
  type ModelOp,
  type StatusActor,
} from '@processia/model';
import { PILOT_FLOW_SCENARIOS } from '@processia/test-fixtures';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DecisionsService } from '../analysis/decisions.service.js';
import { AiProviderRegistry } from '../ai/ai-provider.registry.js';
import { AiService } from '../ai/ai.service.js';
import { AuthError } from '../auth/errors.js';
import { CLOCK, type Clock } from '../auth/services.js';
import { DB } from '../db/db.module.js';
import { JOB_QUEUES, JobsService } from '../jobs/jobs.service.js';
import { ModelService } from '../model/model.service.js';
import type { MissionContext } from '../policy/mission-context.js';
import { updateRun } from '../sources/runs.js';

const itemSchema = z.object({
  processId: z.string().uuid(),
  /** Tâches dont on construit le niveau 3 (mode `detail`). */
  taskIds: z.array(z.string().uuid()),
});
const jobDataSchema = z.object({
  missionId: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string().uuid(),
  mode: z.enum(['flow', 'detail']),
  items: z.array(itemSchema).min(1),
});
export type FlowJobData = z.infer<typeof jobDataSchema>;

/** Une exécution en cours depuis plus longtemps est considérée comme perdue (worker arrêté). */
const STALE_RUN_MS = 30 * 60 * 1000;
const MAX_COMMIT_ATTEMPTS = 3;
const MAX_DECISION_ATTEMPTS = 3;

/** Issue d'un lot, relue par la page : `{"failures":[{"code":"P04.2","error":"…"}]}`. */
function parseFailures(error: string | null): FlowFailureDto[] {
  if (error === null) return [];
  try {
    const parsed = z
      .object({ failures: z.array(z.object({ code: z.string(), error: z.string() })) })
      .safeParse(JSON.parse(error));
    return parsed.success ? parsed.data.failures : [{ code: '', error }];
  } catch {
    return [{ code: '', error }];
  }
}

/**
 * Construction des enchaînements des processus (WP-17, spécification 4.4 `process.flow`) :
 * événements, passerelles, règles de décision et flux de séquence du niveau 2, étapes et données
 * du niveau 3. Le job traite les processus un par un (un ChangeSet `process_flow` par processus,
 * donc une version) et rend compte de sa progression. Tout ce que l'IA écrit est une hypothèse ;
 * le consultant décide (`DecisionsService` pour un élément, `decide` pour tout un processus).
 */
@Injectable()
export class FlowService implements OnModuleInit {
  private readonly logger = new Logger(FlowService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AiProviderRegistry) private readonly registry: AiProviderRegistry,
    @Inject(ModelService) private readonly models: ModelService,
    @Inject(DecisionsService) private readonly decisions: DecisionsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    for (const [pipeline, scenario] of Object.entries(PILOT_FLOW_SCENARIOS)) {
      this.registry.registerFakeScenario(pipeline, scenario as FakeScenario);
    }
    this.jobs.addConsumer(JOB_QUEUES.analysisFlow, (data) => this.process(data));
  }

  // ------------------------------------------------------------------ lecture

  /** Processus du modèle avec l'état de leur enchaînement, et le dernier lot. */
  async overview(ctx: MissionContext): Promise<FlowOverviewDto> {
    return ctx.run(async (tx) => {
      const { model } = await this.models.getModel(tx, ctx.missionId);
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.kind, FLOW_RUN_KIND))
        .orderBy(desc(analysisRuns.createdAt))
        .limit(1);
      return {
        processes: listFlowProcesses(model),
        lastRun:
          run === undefined
            ? null
            : {
                runId: run.id,
                status: run.status as 'queued' | 'running' | 'succeeded' | 'failed',
                progress: run.progress,
                failures: parseFailures(run.error),
              },
      };
    });
  }

  // ------------------------------------------------------------------ lancement

  /**
   * Lance le lot : les processus demandés (ou tous ceux qui n'ont pas d'enchaînement), ou le
   * niveau 3 des tâches indiquées. Un seul lot à la fois par mission (409 `FLOW_IN_PROGRESS`).
   */
  async start(
    ctx: MissionContext,
    userId: string,
    request: StartFlowRequest,
  ): Promise<StartFlowResult> {
    const prepared = await ctx.run(async (tx) => {
      // Deux lancements simultanés ne doivent pas passer la vérification ensemble.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${ctx.missionId}:flow`}, 0))`,
      );
      const recent = new Date(this.clock.now().getTime() - STALE_RUN_MS);
      const [busy] = await tx
        .select({ id: analysisRuns.id })
        .from(analysisRuns)
        .where(
          and(
            eq(analysisRuns.kind, FLOW_RUN_KIND),
            inArray(analysisRuns.status, ['queued', 'running']),
            gt(analysisRuns.createdAt, recent),
          ),
        )
        .limit(1);
      if (busy !== undefined) throw new AuthError('CONFLICT', { reason: 'FLOW_IN_PROGRESS' });
      const { model } = await this.models.getModel(tx, ctx.missionId);
      const { mode, items } = this.resolveItems(model, request);
      if (items.length === 0) throw new AuthError('CONFLICT', { reason: 'NOTHING_TO_BUILD' });
      const [run] = await tx
        .insert(analysisRuns)
        .values({
          missionId: ctx.missionId,
          kind: FLOW_RUN_KIND,
          status: 'queued',
          progress: 0,
          startedBy: userId,
        })
        .returning();
      if (run === undefined) throw new Error('Insertion de l’exécution impossible.');
      await updateRun(tx, ctx.missionId, run.id, null, {});
      return { runId: run.id, mode, items };
    });
    const data: FlowJobData = {
      missionId: ctx.missionId,
      runId: prepared.runId,
      userId,
      mode: prepared.mode,
      items: prepared.items,
    };
    try {
      const jobId = await this.jobs.send(JOB_QUEUES.analysisFlow, data);
      await withMission(this.db, ctx.missionId, (tx) =>
        updateRun(tx, ctx.missionId, prepared.runId, null, { jobId }),
      );
    } catch (error) {
      await withMission(this.db, ctx.missionId, (tx) =>
        updateRun(tx, ctx.missionId, prepared.runId, null, {
          status: 'failed',
          error: 'JOB_ENQUEUE_FAILED',
        }),
      );
      throw error;
    }
    return { runId: prepared.runId };
  }

  /** Cibles du lot : processus sans enchaînement, ou tâches sans niveau 3, regroupées par processus. */
  private resolveItems(
    model: BusinessModel,
    request: StartFlowRequest,
  ): { mode: 'flow' | 'detail'; items: FlowJobData['items'] } {
    const invalid = (path: string, message: string): AuthError =>
      new AuthError('VALIDATION_ERROR', [{ path, message }]);
    if (request.detailTaskIds !== undefined) {
      const byProcess = new Map<string, string[]>();
      for (const id of request.detailTaskIds) {
        const task = model.elements[id];
        if (task?.kind !== 'activity' || task.level !== 'task' || task.parentId === undefined) {
          throw invalid('detailTaskIds', 'Ce n’est pas une tâche du modèle.');
        }
        if (hasTaskDetail(model, id)) continue;
        byProcess.set(task.parentId, [...(byProcess.get(task.parentId) ?? []), id]);
      }
      return {
        mode: 'detail',
        items: [...byProcess].map(([processId, taskIds]) => ({ processId, taskIds })),
      };
    }
    const all = listFlowProcesses(model);
    const ids = request.processIds ?? all.map((p) => p.id);
    for (const id of ids) {
      if (!all.some((p) => p.id === id)) throw invalid('processIds', 'Ce n’est pas un processus.');
    }
    return {
      mode: 'flow',
      items: ids
        .filter((id) => !hasProcessFlow(model, id))
        .map((processId) => ({ processId, taskIds: [] })),
    };
  }

  // ------------------------------------------------------------------ traitement (worker)

  async process(raw: unknown): Promise<void> {
    const data = jobDataSchema.parse(raw);
    const { missionId, runId } = data;
    const patch = (value: Parameters<typeof updateRun>[4]): Promise<unknown> =>
      withMission(this.db, missionId, (tx) => updateRun(tx, missionId, runId, null, value));
    const failures: FlowFailureDto[] = [];
    let lastVersion: number | null = null;
    try {
      await patch({ status: 'running', progress: 2 });
      for (const [index, item] of data.items.entries()) {
        const head = await this.head(missionId);
        const process = head.elements[item.processId];
        const code = process?.code ?? item.processId;
        try {
          const version = await this.buildItem(data, item);
          if (version !== null) lastVersion = version;
        } catch (error) {
          const message = this.describe(error);
          this.logger.warn(`Enchaînement ${code} en échec : ${message}`);
          failures.push({ code, error: message });
        }
        await patch({
          status: 'running',
          progress: Math.min(99, Math.round(((index + 1) / data.items.length) * 100)),
        });
      }
      const allFailed = failures.length === data.items.length;
      await patch({
        status: allFailed ? 'failed' : 'succeeded',
        progress: 100,
        resultVersion: lastVersion,
        error: failures.length === 0 ? null : JSON.stringify({ failures }).slice(0, 4_000),
      });
    } catch (error) {
      this.logger.error(`Lot d'enchaînements ${runId} en échec : ${(error as Error).message}`);
      await patch({ status: 'failed', progress: 100, error: this.describe(error).slice(0, 500) });
    }
  }

  private describe(error: unknown): string {
    if (error instanceof AiError) return error.code;
    return error instanceof Error ? error.message.slice(0, 300) : 'UNKNOWN';
  }

  private async head(missionId: string): Promise<BusinessModel> {
    const { model } = await withMission(this.db, missionId, (tx) =>
      this.models.getModel(tx, missionId),
    );
    return model;
  }

  /** Un processus : un appel `process.flow`, puis un ChangeSet écrit sur la tête du modèle. */
  private async buildItem(
    data: FlowJobData,
    item: FlowJobData['items'][number],
  ): Promise<number | null> {
    const { missionId, userId } = data;
    const first = await this.head(missionId);
    if (data.mode === 'flow' && hasProcessFlow(first, item.processId)) return null;
    const input = buildProcessFlowInput(first, item.processId, data.mode, item.taskIds);
    const run = await this.ai.run(processFlowPipeline, input, { missionId, userId });
    const newId = (): string => uuidv7(this.clock.now().getTime(), randomBytes(10));
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const model = await this.head(missionId);
      const built = buildProcessFlowChangeSet({
        model,
        processId: item.processId,
        mode: data.mode,
        detailTaskIds: item.taskIds,
        output: run.output,
        aiCallId: run.callId,
        at: this.clock.now().toISOString(),
        newId,
      });
      if (built.changeSet === null) return null;
      try {
        const committed = await this.models.commit(missionId, built.changeSet, {
          userId,
          actor: 'ai',
          aiCallId: run.callId,
        });
        return committed.version;
      } catch (error) {
        const stale = error instanceof AuthError && error.code === 'STALE';
        if (!stale || attempt === MAX_COMMIT_ATTEMPTS) throw error;
        this.logger.warn(`Modèle modifié pendant l'écriture (tentative ${attempt}) : reprise.`);
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ décisions groupées

  /**
   * Confirme ou écarte d'un coup les hypothèses d'un processus (enchaînement, tâches proposées,
   * niveau 3) ou du niveau 3 d'une tâche. C'est une décision humaine, tracée comme les décisions
   * élément par élément (ChangeSet `hypothesis_decision`) ; chaque élément reste décidable un par un.
   */
  async decide(
    ctx: MissionContext,
    userId: string,
    processId: string,
    request: FlowDecisionRequest,
  ): Promise<FlowDecisionResult> {
    const actor: StatusActor = ctx.missionRole === 'manager' ? 'mission_lead' : 'consultant';
    for (let attempt = 1; attempt <= MAX_DECISION_ATTEMPTS; attempt += 1) {
      try {
        return await ctx.run(async (tx) => {
          const { model } = await this.models.getModel(tx, ctx.missionId);
          const { changeSet, count } = this.buildDecision(model, processId, userId, request);
          const committed = await this.models.commitInTx(tx, ctx.missionId, changeSet, {
            userId,
            actor,
          });
          return {
            version: committed.version,
            count,
            outcome: request.decision === 'reject' ? 'rejected' : 'confirmed',
          } satisfies FlowDecisionResult;
        });
      } catch (error) {
        const retry =
          error instanceof AuthError &&
          (error.code === 'STALE' || error.code === 'CHANGESET_INVALID');
        if (!retry || attempt === MAX_DECISION_ATTEMPTS) throw error;
      }
    }
    throw new AuthError('CONFLICT', { reason: 'NOTHING_TO_DECIDE' });
  }

  private buildDecision(
    model: BusinessModel,
    processId: string,
    userId: string,
    request: FlowDecisionRequest,
  ): { changeSet: ChangeSet; count: number } {
    const process = model.elements[processId];
    if (process?.kind !== 'activity' || process.level !== 'process') {
      throw new AuthError('NOT_FOUND');
    }
    if (request.taskId !== undefined) {
      const task = model.elements[request.taskId];
      if (task?.kind !== 'activity' || task.level !== 'task' || task.parentId !== processId) {
        throw new AuthError('NOT_FOUND');
      }
    }
    const targets = flowScopeHypotheses(model, processId, request.taskId);
    if (targets.length === 0) throw new AuthError('CONFLICT', { reason: 'NOTHING_TO_DECIDE' });
    const label = `${process.code} « ${process.label} »`;
    const ops: ModelOp[] = [];
    if (request.decision === 'accept') {
      for (const element of targets) {
        const fieldsOp = this.decisions.confirmFields(element, userId);
        if (fieldsOp !== null) ops.push(fieldsOp);
        ops.push({ op: 'set_status', id: element.id, status: 'confirmed' });
      }
      return {
        count: targets.length,
        changeSet: {
          baseVersion: model.version,
          ops,
          cause: 'hypothesis_decision',
          summary: `Confirmation de l’enchaînement de ${label} (${targets.length} éléments)`,
        },
      };
    }
    const plan = planHypothesisRejection(
      model,
      targets.map((e) => e.id),
    );
    if (!plan.ok) {
      throw new AuthError(
        'VALIDATION_ERROR',
        plan.blockedBy.map((b) => ({
          path: 'decision',
          message: `« ${b.code} ${b.label} » est déjà décidé et référence l’enchaînement.`,
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
    for (const id of plan.reject) ops.push({ op: 'reject_hypothesis', id });
    return {
      count: plan.reject.length,
      changeSet: {
        baseVersion: model.version,
        ops,
        cause: 'hypothesis_decision',
        summary: `Enchaînement de ${label} écarté (${plan.reject.length} hypothèses)`,
      },
    };
  }
}
