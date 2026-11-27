import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AiError,
  answerIntegratePipeline,
  buildExtractionChangeSet,
  buildHypothesesChangeSet,
  buildHypothesesInput,
  buildQuestionsInput,
  buildSummaryChangeSet,
  hypothesesPipeline,
  matchExisting,
  mergeCandidates,
  questionsPipeline,
  rankQuestions,
  summarizeModel,
  summaryPipeline,
  summaryTraits,
  verifyChunkCandidates,
  type ChunkInput,
  type FakeScenario,
  type VerifiedCandidate,
} from '@processia/ai';
import {
  MISSION_MESSAGES_CHANNEL,
  type AnswerQuestionResult,
  type ChunkLocator,
  type QuestionDto,
  type QuestionStatus,
  type QuestionUpdatedMessage,
  type SourceKind,
  type StartGuidedResult,
  type StopQuestionsResult,
} from '@processia/contracts';
import {
  analysisRuns,
  notifications,
  questions,
  sourceChunks,
  sources,
  withMission,
  type Database,
  type MissionTx,
} from '@processia/db';
import type { BusinessModel, ChangeSet } from '@processia/model';
import { PILOT_GUIDED_SCENARIOS } from '@processia/test-fixtures';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AiProviderRegistry } from '../ai/ai-provider.registry.js';
import { AiService } from '../ai/ai.service.js';
import { AuthError } from '../auth/errors.js';
import { CLOCK, type Clock } from '../auth/services.js';
import { DB } from '../db/db.module.js';
import { JOB_QUEUES, JobsService } from '../jobs/jobs.service.js';
import { ModelService } from '../model/model.service.js';
import type { MissionContext } from '../policy/mission-context.js';
import {
  ANSWER_RUN_KIND,
  HYPOTHESES_RUN_KIND,
  QUESTIONS_RUN_KIND,
  SUMMARY_RUN_KIND,
  updateRun,
} from '../sources/runs.js';
import { SourcesService } from '../sources/sources.service.js';
import { refLocator } from './extraction.service.js';

const base = {
  missionId: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string().uuid(),
};
const jobDataSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('questions') }),
  z.object({ ...base, kind: z.literal('hypotheses') }),
  z.object({ ...base, kind: z.literal('summary') }),
  z.object({
    ...base,
    kind: z.literal('answer'),
    questionId: z.string().uuid(),
    sourceId: z.string().uuid(),
  }),
]);
export type GuidedJobData = z.infer<typeof jobDataSchema>;

/** Une exécution en cours depuis plus longtemps est considérée comme perdue (worker arrêté). */
const STALE_RUN_MS = 30 * 60 * 1000;
const MAX_COMMIT_ATTEMPTS = 3;
const TITLE_QUESTION_CHARS = 80;

type QuestionRow = typeof questions.$inferSelect;

export function toQuestionDto(row: QuestionRow): QuestionDto {
  return {
    id: row.id,
    concept: row.concept,
    text: row.text,
    rationale: row.rationale,
    blockingScore: row.blockingScore === null ? null : Number(row.blockingScore),
    targetElementIds: row.targetElementIds,
    status: row.status as QuestionStatus,
    answerSourceId: row.answerSourceId,
    answeredBy: row.answeredBy,
    rank: row.rank,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Diffuse `question.updated` : le serveur de coédition le relaie aux consultants connectés. */
async function notifyQuestions(tx: MissionTx, missionId: string): Promise<void> {
  const message: QuestionUpdatedMessage = { type: 'question.updated', missionId };
  await tx.execute(sql`select pg_notify(${MISSION_MESSAGES_CHANNEL}, ${JSON.stringify(message)})`);
}

/**
 * Questionnement guidé et hypothèses (WP-14, spécification 1.4 flux 2 et 3) : questions classées
 * par effet bloquant, réponse figée en source `answer` puis intégrée par `answer.integrate`,
 * hypothèses de connaissance générale, synthèse du métier. Les écritures du modèle passent par
 * `ModelService.commit` (auteur IA : `extracted` ou `hypothesis`, jamais `confirmed`) ; le
 * consultant décide ensuite (`DecisionsService`).
 */
@Injectable()
export class GuidedService implements OnModuleInit {
  private readonly logger = new Logger(GuidedService.name);

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
    for (const [pipeline, scenario] of Object.entries(PILOT_GUIDED_SCENARIOS)) {
      this.registry.registerFakeScenario(pipeline, scenario as FakeScenario);
    }
    this.jobs.addConsumer(JOB_QUEUES.analysisGuided, (data) => this.process(data));
  }

  // ------------------------------------------------------------------ lecture et décisions

  /** Questions de la mission : ouvertes d'abord (rang), puis répondues et passées. */
  async list(tx: MissionTx): Promise<QuestionDto[]> {
    const rows = await tx
      .select()
      .from(questions)
      .orderBy(asc(questions.rank), desc(questions.createdAt));
    const order: Record<string, number> = { open: 0, answered: 1, skipped: 2 };
    return rows
      .map(toQuestionDto)
      .sort(
        (a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || (a.rank ?? 0) - (b.rank ?? 0),
      );
  }

  /** « Passer » : la question n'est pas reposée (son texte reste connu de `questions`). */
  async skip(ctx: MissionContext, questionId: string): Promise<QuestionDto> {
    return ctx.run(async (tx) => {
      const [row] = await tx
        .update(questions)
        .set({ status: 'skipped', rank: null })
        .where(and(eq(questions.id, questionId), eq(questions.status, 'open')))
        .returning();
      if (row === undefined) throw await this.notOpen(tx, questionId);
      await this.rerank(tx);
      await notifyQuestions(tx, ctx.missionId);
      return toQuestionDto(row);
    });
  }

  /** « Arrêter le questionnement » : toutes les questions ouvertes sont passées (CDC 3.7). */
  async stop(ctx: MissionContext): Promise<StopQuestionsResult> {
    return ctx.run(async (tx) => {
      const rows = await tx
        .update(questions)
        .set({ status: 'skipped', rank: null })
        .where(eq(questions.status, 'open'))
        .returning({ id: questions.id });
      if (rows.length > 0) await notifyQuestions(tx, ctx.missionId);
      return { skipped: rows.length };
    });
  }

  /**
   * Réponse à une question : la réponse devient une source `answer` (immuable, découpée) et
   * l'intégration est mise en file. Une question déjà traitée refuse la seconde réponse (409).
   */
  async answer(
    ctx: MissionContext,
    userId: string,
    questionId: string,
    text: string,
  ): Promise<AnswerQuestionResult> {
    const created = await ctx.run(async (tx) => {
      const [row] = await tx.select().from(questions).where(eq(questions.id, questionId)).limit(1);
      if (row === undefined) throw new AuthError('NOT_FOUND');
      if (row.status !== 'open') throw new AuthError('CONFLICT', { reason: 'QUESTION_NOT_OPEN' });
      const source = await this.sourcesService.createTextSource(tx, {
        missionId: ctx.missionId,
        kind: 'answer',
        title: `Réponse : ${row.text.slice(0, TITLE_QUESTION_CHARS)}`,
        text,
        userId,
      });
      const [updated] = await tx
        .update(questions)
        .set({ status: 'answered', answerSourceId: source.id, answeredBy: userId, rank: null })
        .where(and(eq(questions.id, questionId), eq(questions.status, 'open')))
        .returning();
      if (updated === undefined) throw new AuthError('CONFLICT', { reason: 'QUESTION_NOT_OPEN' });
      const runId = await this.createRun(tx, ctx.missionId, ANSWER_RUN_KIND, userId, source.id);
      await this.rerank(tx);
      await notifyQuestions(tx, ctx.missionId);
      return { source, question: toQuestionDto(updated), runId };
    });
    await this.enqueue(ctx.missionId, created.runId, created.source.id, {
      kind: 'answer',
      missionId: ctx.missionId,
      runId: created.runId,
      userId,
      questionId,
      sourceId: created.source.id,
    });
    return created;
  }

  private async notOpen(tx: MissionTx, questionId: string): Promise<AuthError> {
    const [row] = await tx
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.id, questionId))
      .limit(1);
    return row === undefined
      ? new AuthError('NOT_FOUND')
      : new AuthError('CONFLICT', { reason: 'QUESTION_NOT_OPEN' });
  }

  // ------------------------------------------------------------------ lancements

  startQuestions(ctx: MissionContext, userId: string): Promise<StartGuidedResult> {
    return this.start(ctx, userId, QUESTIONS_RUN_KIND, 'questions');
  }

  startHypotheses(ctx: MissionContext, userId: string): Promise<StartGuidedResult> {
    return this.start(ctx, userId, HYPOTHESES_RUN_KIND, 'hypotheses');
  }

  startSummary(ctx: MissionContext, userId: string): Promise<StartGuidedResult> {
    return this.start(ctx, userId, SUMMARY_RUN_KIND, 'summary');
  }

  /** Une seule exécution de chaque genre à la fois par mission (409 `GUIDED_IN_PROGRESS`). */
  private async start(
    ctx: MissionContext,
    userId: string,
    runKind: string,
    kind: 'questions' | 'hypotheses' | 'summary',
  ): Promise<StartGuidedResult> {
    const runId = await ctx.run(async (tx) => {
      // Deux lancements simultanés ne doivent pas passer la vérification ensemble.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${ctx.missionId}:guided:${runKind}`}, 0))`,
      );
      const recent = new Date(this.clock.now().getTime() - STALE_RUN_MS);
      const [busy] = await tx
        .select({ id: analysisRuns.id })
        .from(analysisRuns)
        .where(
          and(
            eq(analysisRuns.kind, runKind),
            inArray(analysisRuns.status, ['queued', 'running']),
            gt(analysisRuns.createdAt, recent),
          ),
        )
        .limit(1);
      if (busy !== undefined) throw new AuthError('CONFLICT', { reason: 'GUIDED_IN_PROGRESS' });
      return this.createRun(tx, ctx.missionId, runKind, userId, null);
    });
    await this.enqueue(ctx.missionId, runId, null, {
      kind,
      missionId: ctx.missionId,
      runId,
      userId,
    });
    return { runId };
  }

  private async createRun(
    tx: MissionTx,
    missionId: string,
    kind: string,
    userId: string,
    sourceId: string | null,
  ): Promise<string> {
    const [run] = await tx
      .insert(analysisRuns)
      .values({ missionId, kind, status: 'queued', progress: 0, startedBy: userId })
      .returning();
    if (run === undefined) throw new Error('Insertion de l’exécution impossible.');
    await updateRun(tx, missionId, run.id, sourceId, {});
    return run.id;
  }

  private async enqueue(
    missionId: string,
    runId: string,
    sourceId: string | null,
    data: GuidedJobData,
  ): Promise<void> {
    try {
      const jobId = await this.jobs.send(JOB_QUEUES.analysisGuided, data);
      await withMission(this.db, missionId, (tx) =>
        updateRun(tx, missionId, runId, sourceId, { jobId }),
      );
    } catch (error) {
      await withMission(this.db, missionId, (tx) =>
        updateRun(tx, missionId, runId, sourceId, {
          status: 'failed',
          error: 'JOB_ENQUEUE_FAILED',
        }),
      );
      throw error;
    }
  }

  // ------------------------------------------------------------------ traitement (worker)

  async process(raw: unknown): Promise<void> {
    const data = jobDataSchema.parse(raw);
    const sourceId = data.kind === 'answer' ? data.sourceId : null;
    const progress = (value: number): Promise<unknown> =>
      withMission(this.db, data.missionId, (tx) =>
        updateRun(tx, data.missionId, data.runId, sourceId, { status: 'running', progress: value }),
      );
    try {
      await progress(5);
      let version: number | null = null;
      switch (data.kind) {
        case 'questions':
          await this.runQuestions(data, progress);
          break;
        case 'hypotheses':
          version = await this.runHypotheses(data, progress);
          break;
        case 'summary':
          version = await this.runSummary(data, progress);
          break;
        case 'answer':
          version = await this.runAnswer(data, progress);
          break;
      }
      await withMission(this.db, data.missionId, async (tx) => {
        await updateRun(tx, data.missionId, data.runId, sourceId, {
          status: 'succeeded',
          progress: 100,
          resultVersion: version,
        });
        await tx.insert(notifications).values({
          userId: data.userId,
          missionId: data.missionId,
          kind: `analysis.${data.kind}_done`,
          payload: { runId: data.runId, version },
        });
      });
    } catch (error) {
      this.logger.error(
        `Exécution ${data.kind} ${data.runId} en échec : ${(error as Error).message}`,
      );
      const message = error instanceof AiError ? error.code : (error as Error).message;
      await withMission(this.db, data.missionId, async (tx) => {
        await updateRun(tx, data.missionId, data.runId, sourceId, {
          status: 'failed',
          progress: 100,
          error: message.slice(0, 500),
        });
        await tx.insert(notifications).values({
          userId: data.userId,
          missionId: data.missionId,
          kind: 'analysis.failed',
          payload: { runId: data.runId, kind: data.kind, error: message.slice(0, 200) },
        });
      });
    }
  }

  private async head(missionId: string): Promise<BusinessModel> {
    const { model } = await withMission(this.db, missionId, (tx) =>
      this.models.getModel(tx, missionId),
    );
    return model;
  }

  /** `questions` : manques de complétude -> questions classées, enregistrées (rang 1 = plus bloquante). */
  private async runQuestions(
    data: Extract<GuidedJobData, { kind: 'questions' }>,
    progress: (value: number) => Promise<unknown>,
  ): Promise<void> {
    const { missionId, userId } = data;
    const model = await this.head(missionId);
    const asked = await withMission(this.db, missionId, async (tx) =>
      (await tx.select({ text: questions.text }).from(questions)).map((q) => q.text),
    );
    await progress(20);
    const input = buildQuestionsInput(model, summarizeModel(model), asked);
    const run = await this.ai.run(questionsPipeline, input, { missionId, userId });
    await progress(70);
    const ranked = rankQuestions(run.output, asked);
    const idByCode = new Map(Object.values(model.elements).map((e) => [e.code, e.id]));
    await withMission(this.db, missionId, async (tx) => {
      if (ranked.length > 0) {
        await tx.insert(questions).values(
          ranked.map((q) => ({
            missionId,
            concept: q.concept,
            text: q.text,
            rationale: q.rationale,
            blockingScore: String(q.blockingScore),
            targetElementIds: q.targetCodes.flatMap((code) => {
              const id = idByCode.get(code);
              return id === undefined ? [] : [id];
            }),
            status: 'open',
          })),
        );
      }
      await this.rerank(tx);
      await notifyQuestions(tx, missionId);
    });
  }

  /** Numérote les questions ouvertes : effet bloquant décroissant, puis ancienneté (rang 1 d'abord). */
  private async rerank(tx: MissionTx): Promise<void> {
    const open = await tx
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.status, 'open'))
      .orderBy(
        desc(sql`coalesce(${questions.blockingScore}, 0)`),
        asc(questions.createdAt),
        asc(questions.id),
      );
    for (const [index, row] of open.entries()) {
      await tx
        .update(questions)
        .set({ rank: index + 1 })
        .where(eq(questions.id, row.id));
    }
  }

  /** `hypotheses` : propositions de connaissance générale, jamais reproposées si rejetées. */
  private async runHypotheses(
    data: Extract<GuidedJobData, { kind: 'hypotheses' }>,
    progress: (value: number) => Promise<unknown>,
  ): Promise<number | null> {
    const { missionId, userId } = data;
    const first = await this.head(missionId);
    await progress(20);
    const run = await this.ai.run(
      hypothesesPipeline,
      buildHypothesesInput(first, summarizeModel(first)),
      { missionId, userId },
    );
    await progress(70);
    return this.commitWithRetry(
      missionId,
      userId,
      run.callId,
      (model) =>
        buildHypothesesChangeSet({
          model,
          output: run.output,
          aiCallId: run.callId,
          at: this.clock.now().toISOString(),
        }).changeSet,
    );
  }

  /** `deliverable.summary` : synthèse de la fiche métier, à confirmer. */
  private async runSummary(
    data: Extract<GuidedJobData, { kind: 'summary' }>,
    progress: (value: number) => Promise<unknown>,
  ): Promise<number | null> {
    const { missionId, userId } = data;
    const first = await this.head(missionId);
    const traits = summaryTraits(first);
    if (traits.length === 0) throw new Error('NO_CONFIRMED_TRAIT');
    await progress(30);
    const run = await this.ai.run(
      summaryPipeline,
      { traits: traits.map((x) => ({ facet: x.facet, label: x.label, text: x.text })) },
      { missionId, userId },
    );
    await progress(70);
    return this.commitWithRetry(missionId, userId, run.callId, (model) => {
      const built = buildSummaryChangeSet({
        model,
        output: run.output,
        aiCallId: run.callId,
        at: this.clock.now().toISOString(),
      });
      return built.changeSet;
    });
  }

  /** `answer.integrate` : éléments `extracted` qui citent la source `answer`. */
  private async runAnswer(
    data: Extract<GuidedJobData, { kind: 'answer' }>,
    progress: (value: number) => Promise<unknown>,
  ): Promise<number | null> {
    const { missionId, userId, sourceId, questionId } = data;
    const loaded = await withMission(this.db, missionId, async (tx) => {
      const [source] = await tx.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
      const rows = await tx
        .select()
        .from(sourceChunks)
        .where(eq(sourceChunks.sourceId, sourceId))
        .orderBy(asc(sourceChunks.ordinal));
      const [question] = await tx
        .select()
        .from(questions)
        .where(eq(questions.id, questionId))
        .limit(1);
      return { source, rows, question };
    });
    const { source, rows, question } = loaded;
    if (source === undefined || question === undefined || rows.length === 0) {
      throw new Error('ANSWER_NOT_FOUND');
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
    const head0 = await this.head(missionId);
    const summary = summarizeModel(head0);
    const targets = summary.filter((e) =>
      question.targetElementIds.some((id) => head0.elements[id]?.code === e.code),
    );
    const verified: VerifiedCandidate[] = [];
    let lastCallId: string | null = null;
    for (const [index, chunk] of chunks.entries()) {
      const run = await this.ai.run(
        answerIntegratePipeline,
        {
          question: { text: question.text, concept: question.concept },
          model: summary,
          targets,
          chunk,
        },
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
    return this.commitWithRetry(missionId, userId, lastCallId, (model) => {
      const matches = matchExisting(merged.candidates, merged.mergedInto, model);
      return buildExtractionChangeSet({
        model,
        candidates: merged.candidates,
        mergedInto: merged.mergedInto,
        matches,
        discrepancies: [],
        at: this.clock.now().toISOString(),
        cause: 'answer',
        summary: `Réponse à une question : ${question.text.slice(0, TITLE_QUESTION_CHARS)}`,
      }).changeSet;
    });
  }

  /**
   * Écrit le ChangeSet calculé sur la tête du modèle, avec auteur IA. Si le modèle change
   * pendant l'écriture (`STALE`), il est recalculé sur la nouvelle tête. `null` : rien à écrire.
   */
  private async commitWithRetry(
    missionId: string,
    userId: string,
    aiCallId: string | null,
    build: (model: BusinessModel) => ChangeSet | null,
  ): Promise<number | null> {
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const model = await this.head(missionId);
      const changeSet = build(model);
      // Rien à écrire : l'exécution ne produit aucune version.
      if (changeSet === null) return null;
      try {
        const committed = await this.models.commit(missionId, changeSet, {
          userId,
          actor: 'ai',
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
}
