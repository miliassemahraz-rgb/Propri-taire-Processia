import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AiError,
  applyReconcileResult,
  buildExtractionChangeSet,
  extractionChunkPipeline,
  matchExisting,
  mergeCandidates,
  prepareReconcileInput,
  reconcilePipeline,
  summarizeCandidates,
  summarizeModel,
  verifyChunkCandidates,
  type ChunkInput,
  type ExtractionStats,
  type FakeScenario,
  type VerifiedCandidate,
} from '@processia/ai';
import type {
  ChunkLocator,
  ExtractionSummary,
  SourceKind,
  StartExtractionResult,
} from '@processia/contracts';
import {
  analysisRuns,
  notifications,
  sourceChunks,
  sources,
  withMission,
  type Database,
} from '@processia/db';
import type { BusinessModel } from '@processia/model';
import { PILOT_SCENARIOS } from '@processia/test-fixtures';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AiProviderRegistry } from '../ai/ai-provider.registry.js';
import { AiService } from '../ai/ai.service.js';
import { AuthError } from '../auth/errors.js';
import { CLOCK, type Clock } from '../auth/services.js';
import { DB } from '../db/db.module.js';
import { JOB_QUEUES, JobsService } from '../jobs/jobs.service.js';
import { ModelService } from '../model/model.service.js';
import type { MissionContext } from '../policy/mission-context.js';
import { EXTRACTION_RUN_KIND, updateRun } from '../sources/runs.js';
import { SourcesService } from '../sources/sources.service.js';

const jobDataSchema = z.object({
  missionId: z.string().uuid(),
  sourceId: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type ExtractionJobData = z.infer<typeof jobDataSchema>;

/** Une exécution en cours depuis plus longtemps est considérée comme perdue (worker arrêté). */
const STALE_RUN_MS = 30 * 60 * 1000;
const MAX_COMMIT_ATTEMPTS = 3;

export const SOURCE_NOT_READY = 'SOURCE_NOT_READY';

/** Localisateur de morceau (contrat) -> localisateur d'une `SourceRef` du modèle. */
export function refLocator(locator: ChunkLocator | null): ChunkInput['locator'] {
  if (locator === null) return {};
  switch (locator.kind) {
    case 'page':
      return { page: locator.pageStart };
    case 'cell':
      return { sheet: locator.sheet, cell: locator.range };
    case 'paragraph':
      return { paragraph: locator.paragraphStart };
    case 'line':
      return { paragraph: locator.lineStart };
  }
}

/**
 * Job `analysis.extraction` (WP-12) : extrait les candidats de chaque morceau d'une source
 * (`extraction.chunk`), vérifie les citations, réconcilie avec le modèle (`reconcile`), convertit
 * en ChangeSet par du code déterministe, puis l'écrit par `ModelService.commit` (auteur IA :
 * `extracted` ou `hypothesis`, jamais `confirmed`). Une version produite n'est jamais décidée
 * par l'IA : le consultant confirme ensuite (CDC 3.1).
 */
@Injectable()
export class ExtractionService implements OnModuleInit {
  private readonly logger = new Logger(ExtractionService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AiProviderRegistry) private readonly registry: AiProviderRegistry,
    @Inject(ModelService) private readonly models: ModelService,
    @Inject(SourcesService) private readonly sourcesService: SourcesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    // Scénario factice du pilote : sorties scriptées des pipelines d'extraction (spécification 4.2).
    for (const [pipeline, scenario] of Object.entries(PILOT_SCENARIOS)) {
      this.registry.registerFakeScenario(pipeline, scenario as FakeScenario);
    }
    this.jobs.addConsumer(JOB_QUEUES.analysisExtraction, (data) => this.process(data));
  }

  /**
   * « Analyser » : sans `sourceId`, la description est figée (révision suivante) puis analysée ;
   * sinon la source indiquée (document lisible, texte figé) est analysée.
   */
  async start(
    ctx: MissionContext,
    userId: string,
    sourceId?: string,
  ): Promise<StartExtractionResult> {
    await ctx.run(async (tx) => {
      const recent = new Date(this.clock.now().getTime() - STALE_RUN_MS);
      const [busy] = await tx
        .select({ id: analysisRuns.id })
        .from(analysisRuns)
        .where(
          and(
            eq(analysisRuns.kind, EXTRACTION_RUN_KIND),
            inArray(analysisRuns.status, ['queued', 'running']),
            gt(analysisRuns.createdAt, recent),
          ),
        )
        .limit(1);
      if (busy !== undefined) throw new AuthError('CONFLICT', { reason: 'ANALYSIS_IN_PROGRESS' });
    });
    const source =
      sourceId === undefined
        ? await this.sourcesService.freezeDescription(ctx, userId)
        : await ctx.run((tx) => this.sourcesService.detail(tx, sourceId));
    if (source.textStatus !== 'extracted' || source.chunkCount === 0) {
      throw new AuthError('VALIDATION_ERROR', [
        { path: 'sourceId', message: `La source n'est pas lisible (${source.textStatus}).` },
      ]);
    }
    const runId = await ctx.run(async (tx) => {
      const [run] = await tx
        .insert(analysisRuns)
        .values({
          missionId: ctx.missionId,
          kind: EXTRACTION_RUN_KIND,
          status: 'queued',
          progress: 0,
          startedBy: userId,
        })
        .returning();
      if (run === undefined) throw new Error('Insertion de l’exécution impossible.');
      await updateRun(tx, ctx.missionId, run.id, source.id, {});
      return run.id;
    });
    const data: ExtractionJobData = {
      missionId: ctx.missionId,
      sourceId: source.id,
      runId,
      userId,
    };
    try {
      const jobId = await this.jobs.send(JOB_QUEUES.analysisExtraction, data);
      await ctx.run((tx) => updateRun(tx, ctx.missionId, runId, source.id, { jobId }));
    } catch (error) {
      await ctx.run((tx) =>
        updateRun(tx, ctx.missionId, runId, source.id, {
          status: 'failed',
          error: 'JOB_ENQUEUE_FAILED',
        }),
      );
      throw error;
    }
    return { runId, source };
  }

  async process(raw: unknown): Promise<void> {
    const data = jobDataSchema.parse(raw);
    const { missionId, sourceId, runId, userId } = data;
    const progress = (value: number): Promise<unknown> =>
      withMission(this.db, missionId, (tx) =>
        updateRun(tx, missionId, runId, sourceId, { status: 'running', progress: value }),
      );
    try {
      await progress(5);
      const loaded = await withMission(this.db, missionId, async (tx) => {
        const [source] = await tx.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
        const rows = await tx
          .select()
          .from(sourceChunks)
          .where(eq(sourceChunks.sourceId, sourceId))
          .orderBy(asc(sourceChunks.ordinal));
        return { source, rows };
      });
      const { source, rows } = loaded;
      if (source === undefined || source.textStatus !== 'extracted' || rows.length === 0) {
        await this.fail(data, SOURCE_NOT_READY);
        return;
      }
      const chunks: ChunkInput[] = rows.map((row) => ({
        chunkId: row.id,
        sourceId,
        sourceRevision: source.revision,
        origin: source.kind as SourceKind,
        title: source.title,
        text: row.text,
        locator: refLocator(row.locator as ChunkLocator | null),
      }));

      // 1. Extraction par morceau, avec vérification des citations (spécification 4.5).
      const head0 = await this.head(missionId);
      const verified: VerifiedCandidate[] = [];
      let lastCallId: string | null = null;
      for (const [index, chunk] of chunks.entries()) {
        const run = await this.ai.run(
          extractionChunkPipeline,
          { chunk, model: [...summarizeModel(head0), ...summarizeCandidates(verified)] },
          { missionId, userId },
        );
        lastCallId = run.callId;
        verified.push(
          ...verifyChunkCandidates(
            { chunk, candidates: run.output.candidates, aiCallId: run.callId },
            index,
          ),
        );
        await progress(10 + Math.round((60 * (index + 1)) / chunks.length));
      }
      const merged = mergeCandidates(verified);

      // 2. Réconciliation, conversion et écriture (reprise si le modèle a changé entre-temps).
      let stats: ExtractionStats | undefined;
      let version: number | null = null;
      for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
        const model = await this.head(missionId);
        const matches = matchExisting(merged.candidates, merged.mergedInto, model);
        let plan = {
          candidates: merged.candidates,
          mergedInto: merged.mergedInto,
          matches,
          discrepancies: [] as ReturnType<typeof applyReconcileResult>['discrepancies'],
        };
        if (Object.keys(model.elements).length > 0) {
          const reconciled = await this.ai.run(
            reconcilePipeline,
            prepareReconcileInput(merged.candidates, matches, model),
            { missionId, userId },
          );
          lastCallId = reconciled.callId ?? lastCallId;
          plan = applyReconcileResult({ ...merged, matches }, reconciled.output, model);
        }
        await progress(80);
        const built = buildExtractionChangeSet({
          model,
          ...plan,
          at: this.clock.now().toISOString(),
        });
        stats = built.stats;
        if (built.changeSet === null) {
          version = model.version;
          break;
        }
        try {
          const committed = await this.models.commit(missionId, built.changeSet, {
            userId,
            actor: 'ai',
            aiCallId: lastCallId,
          });
          version = committed.version;
          break;
        } catch (error) {
          const stale = error instanceof AuthError && error.code === 'STALE';
          if (!stale || attempt === MAX_COMMIT_ATTEMPTS) throw error;
          this.logger.warn(`Modèle modifié pendant l'extraction (tentative ${attempt}) : reprise.`);
        }
      }
      if (stats === undefined) throw new Error('Extraction sans résultat.');
      const summary: ExtractionSummary = {
        sourceId,
        version,
        candidates: stats.candidates,
        created: stats.created,
        extracted: stats.extracted,
        hypotheses: stats.hypotheses,
        citationsDemoted: stats.citationsDemoted,
        matched: stats.matched,
        refsAdded: stats.refsAdded,
        discrepancies: stats.discrepancies,
        skipped: stats.skipped,
      };
      await withMission(this.db, missionId, async (tx) => {
        await updateRun(tx, missionId, runId, sourceId, {
          status: 'succeeded',
          progress: 100,
          resultVersion: version,
        });
        await tx.insert(notifications).values({
          userId,
          missionId,
          kind: 'analysis.extraction_done',
          payload: summary,
        });
      });
    } catch (error) {
      this.logger.error(`Extraction ${runId} en échec : ${(error as Error).message}`);
      await this.fail(data, error instanceof AiError ? error.code : (error as Error).message);
    }
  }

  private async head(missionId: string): Promise<BusinessModel> {
    const { model } = await withMission(this.db, missionId, (tx) =>
      this.models.getModel(tx, missionId),
    );
    return model;
  }

  private async fail(data: ExtractionJobData, error: string): Promise<void> {
    await withMission(this.db, data.missionId, async (tx) => {
      await updateRun(tx, data.missionId, data.runId, data.sourceId, {
        status: 'failed',
        progress: 100,
        error: error.slice(0, 500),
      });
      await tx.insert(notifications).values({
        userId: data.userId,
        missionId: data.missionId,
        kind: 'analysis.failed',
        payload: { sourceId: data.sourceId, runId: data.runId, error: error.slice(0, 200) },
      });
    });
  }
}
