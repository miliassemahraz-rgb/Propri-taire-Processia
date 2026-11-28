import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AiError,
  buildDiagnosticInput,
  diagnosticPipeline,
  listDiagnosticMacros,
  resolveDiagnosticOutput,
  type FakeScenario,
} from '@processia/ai';
import {
  DIAGNOSTIC_RUN_KIND,
  type DiagnosticFailureDto,
  type DiagnosticOverviewDto,
  type StartDiagnosticResult,
} from '@processia/contracts';
import { analysisRuns, withMission, type Database } from '@processia/db';
import { buildFindingsChangeSet, runDetectors, type FindingCandidate } from '@processia/diagnostic';
import { deliverableView, type BusinessModel } from '@processia/model';
import { PILOT_DIAGNOSTIC_SCENARIOS } from '@processia/test-fixtures';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AiProviderRegistry } from '../ai/ai-provider.registry.js';
import { AiService } from '../ai/ai.service.js';
import { AuthError } from '../auth/errors.js';
import { CLOCK, type Clock } from '../auth/services.js';
import { DB } from '../db/db.module.js';
import { JOB_QUEUES, JobsService } from '../jobs/jobs.service.js';
import { ModelService } from '../model/model.service.js';
import type { MissionContext } from '../policy/mission-context.js';
import { updateRun } from '../sources/runs.js';

const jobDataSchema = z.object({
  missionId: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type DiagnosticJobData = z.infer<typeof jobDataSchema>;

/** Une exécution en cours depuis plus longtemps est considérée comme perdue (worker arrêté). */
const STALE_RUN_MS = 30 * 60 * 1000;
const MAX_COMMIT_ATTEMPTS = 3;

/** Issue d'une exécution, relue par la page : `{"failures":[{"code":"P04","error":"…"}]}`. */
function parseFailures(error: string | null): DiagnosticFailureDto[] {
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

/** Le diagnostic porte sur l'AS-IS livrable : confirmé ou validé, sans hypothèse (spécification 4.4). */
export const diagnosticBase = (head: BusinessModel): BusinessModel => deliverableView(head);

/**
 * Diagnostic de l'AS-IS validé (WP-21, spécification 4.4). Le job passe d'abord les détecteurs
 * déterministes (`packages/diagnostic`, sans IA) sur tout l'AS-IS, puis appelle le pipeline
 * `diagnostic` macroprocessus par macroprocessus (contexte réduit, risque R-2). Chaque lot écrit
 * un ChangeSet `diagnostic` : des constats `hypothesis` que le consultant confirme ou rejette
 * comme les autres hypothèses. Rien n'est reproposé : un constat présent ou rejeté est ignoré, donc
 * relancer le diagnostic est sans danger.
 */
@Injectable()
export class DiagnosticService implements OnModuleInit {
  private readonly logger = new Logger(DiagnosticService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AiProviderRegistry) private readonly registry: AiProviderRegistry,
    @Inject(ModelService) private readonly models: ModelService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    for (const [pipeline, scenario] of Object.entries(PILOT_DIAGNOSTIC_SCENARIOS)) {
      this.registry.registerFakeScenario(pipeline, scenario as FakeScenario);
    }
    this.jobs.addConsumer(JOB_QUEUES.analysisDiagnostic, (data) => this.process(data));
  }

  // ------------------------------------------------------------------ lecture

  async overview(ctx: MissionContext): Promise<DiagnosticOverviewDto> {
    return ctx.run(async (tx) => {
      const { model } = await this.models.getModel(tx, ctx.missionId);
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.kind, DIAGNOSTIC_RUN_KIND))
        .orderBy(desc(analysisRuns.createdAt))
        .limit(1);
      return {
        macroCount: listDiagnosticMacros(diagnosticBase(model)).length,
        findingCount: Object.values(model.elements).filter((e) => e.kind === 'finding').length,
        lastRun:
          run === undefined
            ? null
            : {
                runId: run.id,
                status: run.status as 'queued' | 'running' | 'succeeded' | 'failed',
                progress: run.progress,
                resultVersion: run.resultVersion,
                failures: parseFailures(run.error),
              },
      };
    });
  }

  // ------------------------------------------------------------------ lancement

  /** Lance le diagnostic. Une seule exécution à la fois par mission (409 `DIAGNOSTIC_IN_PROGRESS`). */
  async start(ctx: MissionContext, userId: string): Promise<StartDiagnosticResult> {
    const runId = await ctx.run(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${ctx.missionId}:diagnostic`}, 0))`,
      );
      const recent = new Date(this.clock.now().getTime() - STALE_RUN_MS);
      const [busy] = await tx
        .select({ id: analysisRuns.id })
        .from(analysisRuns)
        .where(
          and(
            eq(analysisRuns.kind, DIAGNOSTIC_RUN_KIND),
            inArray(analysisRuns.status, ['queued', 'running']),
            gt(analysisRuns.createdAt, recent),
          ),
        )
        .limit(1);
      if (busy !== undefined) throw new AuthError('CONFLICT', { reason: 'DIAGNOSTIC_IN_PROGRESS' });
      const { model } = await this.models.getModel(tx, ctx.missionId);
      if (listDiagnosticMacros(diagnosticBase(model)).length === 0) {
        throw new AuthError('CONFLICT', { reason: 'NOTHING_TO_DIAGNOSE' });
      }
      const [run] = await tx
        .insert(analysisRuns)
        .values({
          missionId: ctx.missionId,
          kind: DIAGNOSTIC_RUN_KIND,
          status: 'queued',
          progress: 0,
          startedBy: userId,
        })
        .returning();
      if (run === undefined) throw new Error('Insertion de l’exécution impossible.');
      await updateRun(tx, ctx.missionId, run.id, null, {});
      return run.id;
    });
    const data: DiagnosticJobData = { missionId: ctx.missionId, runId, userId };
    try {
      const jobId = await this.jobs.send(JOB_QUEUES.analysisDiagnostic, data);
      await withMission(this.db, ctx.missionId, (tx) =>
        updateRun(tx, ctx.missionId, runId, null, { jobId }),
      );
    } catch (error) {
      await withMission(this.db, ctx.missionId, (tx) =>
        updateRun(tx, ctx.missionId, runId, null, {
          status: 'failed',
          error: 'JOB_ENQUEUE_FAILED',
        }),
      );
      throw error;
    }
    return { runId };
  }

  // ------------------------------------------------------------------ traitement (worker)

  async process(raw: unknown): Promise<void> {
    const { missionId, runId, userId } = jobDataSchema.parse(raw);
    const patch = (value: Parameters<typeof updateRun>[4]): Promise<unknown> =>
      withMission(this.db, missionId, (tx) => updateRun(tx, missionId, runId, null, value));
    const failures: DiagnosticFailureDto[] = [];
    let lastVersion: number | null = null;
    try {
      await patch({ status: 'running', progress: 2 });
      const start = await this.head(missionId);
      const macros = listDiagnosticMacros(diagnosticBase(start));
      const steps = macros.length + 1;

      // 1. Détecteurs déterministes sur tout l'AS-IS.
      let version: number | null = null;
      let rules: FindingCandidate[] = [];
      try {
        const out = await this.writeDeterministic(missionId, userId);
        version = out.version;
        rules = out.candidates;
      } catch (error) {
        const message = this.describe(error);
        this.logger.warn(`Détecteurs en échec : ${message}`);
        failures.push({ code: 'rules', error: message });
      }
      if (version !== null) lastVersion = version;
      await patch({ status: 'running', progress: Math.round((1 / steps) * 100) });

      // 2. Pipeline `diagnostic`, un macroprocessus à la fois.
      for (const [index, macro] of macros.entries()) {
        try {
          const written = await this.diagnoseMacro(missionId, userId, macro.id, rules);
          if (written !== null) lastVersion = written;
        } catch (error) {
          const message = this.describe(error);
          this.logger.warn(`Diagnostic de ${macro.code} en échec : ${message}`);
          failures.push({ code: macro.code, error: message });
        }
        await patch({
          status: 'running',
          progress: Math.min(99, Math.round(((index + 2) / steps) * 100)),
        });
      }
      const allFailed = failures.length >= steps;
      await patch({
        status: allFailed ? 'failed' : 'succeeded',
        progress: 100,
        resultVersion: lastVersion,
        error: failures.length === 0 ? null : JSON.stringify({ failures }).slice(0, 4_000),
      });
    } catch (error) {
      this.logger.error(`Diagnostic ${runId} en échec : ${(error as Error).message}`);
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

  /** Commit avec reprise quand le modèle a avancé pendant l'écriture. */
  private async commitWithRetry(
    missionId: string,
    userId: string,
    actor: 'system' | 'ai',
    aiCallId: string | null,
    build: (head: BusinessModel) => ReturnType<typeof buildFindingsChangeSet>,
  ): Promise<number | null> {
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const built = build(await this.head(missionId));
      if (built.changeSet === null) return null;
      try {
        const committed = await this.models.commit(missionId, built.changeSet, {
          userId,
          actor,
          aiCallId,
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

  private async writeDeterministic(
    missionId: string,
    userId: string,
  ): Promise<{ version: number | null; candidates: FindingCandidate[] }> {
    const candidates = runDetectors(diagnosticBase(await this.head(missionId)));
    const version = await this.commitWithRetry(missionId, userId, 'system', null, (head) =>
      buildFindingsChangeSet({
        model: head,
        candidates,
        at: this.clock.now().toISOString(),
        summary: 'Diagnostic : constats des détecteurs déterministes',
      }),
    );
    return { version, candidates };
  }

  /** Un macroprocessus : un appel `diagnostic`, puis un ChangeSet de constats `hypothesis`. */
  private async diagnoseMacro(
    missionId: string,
    userId: string,
    macroId: string,
    rules: readonly FindingCandidate[],
  ): Promise<number | null> {
    const head = await this.head(missionId);
    const base = diagnosticBase(head);
    if (base.elements[macroId] === undefined) return null;
    const present = Object.values(head.elements).flatMap((e) => (e.kind === 'finding' ? [e] : []));
    const rejected = head.rejectedHypotheses.flatMap((r) =>
      r.element.kind === 'finding' ? [r.element] : [],
    );
    const input = buildDiagnosticInput(base, macroId, [...rules, ...present, ...rejected]);
    const run = await this.ai.run(diagnosticPipeline, input, { missionId, userId });
    const resolved = resolveDiagnosticOutput(base, macroId, run.output);
    const macro = base.elements[macroId];
    return this.commitWithRetry(missionId, userId, 'ai', run.callId, (model) =>
      buildFindingsChangeSet({
        model,
        candidates: resolved,
        at: this.clock.now().toISOString(),
        aiCallId: run.callId,
        summary: `Diagnostic de ${macro?.code ?? ''} « ${macro?.label ?? ''} » (${resolved.length} constats proposés)`,
      }),
    );
  }
}
