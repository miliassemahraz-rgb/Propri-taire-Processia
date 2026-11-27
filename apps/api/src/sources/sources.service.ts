import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  PRESIGNED_URL_TTL_SECONDS,
  type ChunkDto,
  type ChunkLocator,
  type ChunkViewDto,
  type RunDto,
  type PresignedUrlDto,
  type RunStatus,
  type SourceDto,
  type SourceKind,
  type TextStatus,
  type UploadSourceResult,
} from '@processia/contracts';
import { analysisRuns, sourceChunks, sources, yjsDocuments, type MissionTx } from '@processia/db';
import { blocksFromParagraphs, chunkBlocks, detectFile, IngestError } from '@processia/ingest';
import { and, asc, count, desc, eq, max, sql } from 'drizzle-orm';
import { AuthError } from '../auth/errors.js';
import { JOB_QUEUES, JobsService } from '../jobs/jobs.service.js';
import type { MissionContext } from '../policy/mission-context.js';
import { sourceKey, StorageService } from '../storage/storage.service.js';
import { INGEST_RUN_KIND, updateRun } from './runs.js';
import { descriptionTextFromState, workspaceDocName } from './yjs-text.js';

type SourceRow = typeof sources.$inferSelect;

/** Titre des sources issues de la description du métier : leurs révisions se suivent. */
export const DESCRIPTION_TITLE = 'Description du métier';

/** Données de la tâche `ingest.document`. */
export interface IngestJobData {
  missionId: string;
  sourceId: string;
  runId: string;
  userId: string;
}

function toDto(row: SourceRow, chunkCount: number): SourceDto {
  return {
    id: row.id,
    kind: row.kind as SourceKind,
    title: row.title,
    revision: row.revision,
    mime: row.mime,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    textStatus: row.textStatus as TextStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    chunkCount,
  };
}

function runDto(row: typeof analysisRuns.$inferSelect): RunDto {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as RunStatus,
    progress: row.progress,
    error: row.error,
    resultVersion: row.resultVersion,
  };
}

/** Insère des morceaux par lots (une source peut en compter plusieurs centaines). */
export async function insertChunks(
  tx: MissionTx,
  missionId: string,
  sourceId: string,
  chunks: { ordinal: number; text: string; locator: ChunkLocator }[],
): Promise<void> {
  for (let i = 0; i < chunks.length; i += 200) {
    await tx.insert(sourceChunks).values(
      chunks.slice(i, i + 200).map((chunk) => ({
        missionId,
        sourceId,
        ordinal: chunk.ordinal,
        text: chunk.text,
        locator: chunk.locator,
      })),
    );
  }
}

/** Dépôt, lecture et fige des sources d'une mission (WP-11). */
@Injectable()
export class SourcesService {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  /**
   * Dépose un document : type vérifié par signature, taille, sha256, stockage S3, ligne `sources`
   * (immuable), puis tâche `ingest.document` suivie par `run.progress`.
   */
  async uploadDocument(
    ctx: MissionContext,
    userId: string,
    file: { originalname: string; buffer: Buffer },
  ): Promise<UploadSourceResult> {
    let detected;
    try {
      detected = await detectFile(file.buffer, file.originalname);
    } catch (error) {
      if (error instanceof IngestError && error.code !== 'CORRUPT_FILE') {
        throw new AuthError(error.code, { reason: error.message });
      }
      throw error;
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    let storageKey: string | undefined;

    let created: UploadSourceResult;
    try {
      created = await ctx.run(async (tx) => {
        const [row] = await tx
          .insert(sources)
          .values({
            missionId: ctx.missionId,
            kind: 'document',
            title: file.originalname,
            mime: detected.mime,
            sha256,
            sizeBytes: file.buffer.byteLength,
            textStatus: 'pending',
            createdBy: userId,
          })
          .returning();
        if (row === undefined) throw new Error('Insertion de la source impossible.');
        storageKey = sourceKey(ctx.missionId, row.id, file.originalname);
        await this.storage.putSource(storageKey, file.buffer, detected.mime);
        const [updated] = await tx
          .update(sources)
          .set({ storageKey })
          .where(eq(sources.id, row.id))
          .returning();
        const [run] = await tx
          .insert(analysisRuns)
          .values({
            missionId: ctx.missionId,
            kind: INGEST_RUN_KIND,
            status: 'queued',
            progress: 0,
            startedBy: userId,
          })
          .returning();
        if (updated === undefined || run === undefined) throw new Error('Insertion impossible.');
        await updateRun(tx, ctx.missionId, run.id, row.id, {});
        return { source: toDto(updated, 0), runId: run.id };
      });
    } catch (error) {
      // La transaction est annulée : l'objet S3 éventuellement écrit n'a plus de ligne.
      if (storageKey !== undefined)
        await this.storage.deleteSource(storageKey).catch(() => undefined);
      throw error;
    }

    const data: IngestJobData = {
      missionId: ctx.missionId,
      sourceId: created.source.id,
      runId: created.runId,
      userId,
    };
    try {
      const jobId = await this.jobs.send(JOB_QUEUES.ingestDocument, data);
      await ctx.run((tx) =>
        updateRun(tx, ctx.missionId, created.runId, created.source.id, { jobId }),
      );
    } catch (error) {
      await ctx.run(async (tx) => {
        await tx
          .update(sources)
          .set({ textStatus: 'failed' })
          .where(eq(sources.id, created.source.id));
        await updateRun(tx, ctx.missionId, created.runId, created.source.id, {
          status: 'failed',
          error: 'JOB_ENQUEUE_FAILED',
        });
      });
      throw error;
    }
    return created;
  }

  /**
   * Fige un texte en source immuable, découpée en morceaux. Pour la description, chaque appel
   * crée la révision suivante ; les révisions précédentes restent lisibles.
   */
  async createTextSource(
    tx: MissionTx,
    input: {
      missionId: string;
      kind: 'free_text' | 'answer';
      title: string;
      text: string;
      userId: string;
    },
  ): Promise<SourceDto> {
    const text = input.text.trim();
    if (text.length === 0) {
      throw new AuthError('VALIDATION_ERROR', [{ path: 'text', message: 'Le texte est vide.' }]);
    }
    // Deux soumissions simultanées ne doivent pas obtenir la même révision.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.missionId}:${input.kind}:${input.title}`}, 0))`,
    );
    const [last] =
      input.kind === 'free_text'
        ? await tx
            .select({ revision: max(sources.revision) })
            .from(sources)
            .where(and(eq(sources.kind, 'free_text'), eq(sources.title, input.title)))
        : [];
    const revision = (last?.revision ?? 0) + 1;
    const bytes = Buffer.from(text, 'utf8');
    const [row] = await tx
      .insert(sources)
      .values({
        missionId: input.missionId,
        kind: input.kind,
        title: input.title,
        revision,
        mime: 'text/plain',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.byteLength,
        textStatus: 'extracted',
        createdBy: input.userId,
      })
      .returning();
    if (row === undefined) throw new Error('Insertion de la source impossible.');
    const chunks = chunkBlocks(blocksFromParagraphs(text));
    await insertChunks(tx, input.missionId, row.id, chunks);
    return toDto(row, chunks.length);
  }

  /** Fige la description Yjs du document `workspace` en source `free_text` (« Analyser »). */
  async freezeDescription(ctx: MissionContext, userId: string): Promise<SourceDto> {
    return ctx.run(async (tx) => {
      const [doc] = await tx
        .select({ state: yjsDocuments.state })
        .from(yjsDocuments)
        .where(eq(yjsDocuments.name, workspaceDocName(ctx.missionId)))
        .limit(1);
      const text = doc === undefined ? '' : descriptionTextFromState(doc.state);
      if (text.length === 0) {
        throw new AuthError('VALIDATION_ERROR', [
          { path: 'description', message: 'La description du métier est vide.' },
        ]);
      }
      return this.createTextSource(tx, {
        missionId: ctx.missionId,
        kind: 'free_text',
        title: DESCRIPTION_TITLE,
        text,
        userId,
      });
    });
  }

  async list(tx: MissionTx): Promise<SourceDto[]> {
    const rows = await tx
      .select({
        source: sources,
        chunkCount: sql<number>`(select count(*)::int from source_chunks c where c.source_id = ${sources.id})`,
      })
      .from(sources)
      .orderBy(desc(sources.createdAt));
    return rows.map((r) => toDto(r.source, r.chunkCount));
  }

  private async load(tx: MissionTx, sourceId: string): Promise<SourceRow> {
    const [row] = await tx.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
    if (row === undefined) throw new AuthError('NOT_FOUND');
    return row;
  }

  async detail(tx: MissionTx, sourceId: string): Promise<SourceDto> {
    const row = await this.load(tx, sourceId);
    const [counted] = await tx
      .select({ n: count() })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, sourceId));
    return toDto(row, counted?.n ?? 0);
  }

  /** Progression d'une exécution (`run.progress` en lecture, pour qui n'écoute pas la coédition). */
  async run(tx: MissionTx, runId: string): Promise<RunDto> {
    const [row] = await tx.select().from(analysisRuns).where(eq(analysisRuns.id, runId)).limit(1);
    if (row === undefined) throw new AuthError('NOT_FOUND');
    return runDto(row);
  }

  async chunks(tx: MissionTx, sourceId: string): Promise<ChunkDto[]> {
    await this.load(tx, sourceId);
    const rows = await tx
      .select()
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, sourceId))
      .orderBy(asc(sourceChunks.ordinal));
    return rows.map((r) => ({
      id: r.id,
      ordinal: r.ordinal,
      text: r.text,
      locator: r.locator as ChunkLocator | null,
    }));
  }

  /** Un morceau avec le passage surligné par positions de caractères (visionneuse de source). */
  async chunkView(
    tx: MissionTx,
    sourceId: string,
    ordinal: number,
    highlight: { charStart?: number | undefined; charEnd?: number | undefined },
  ): Promise<ChunkViewDto> {
    const source = await this.load(tx, sourceId);
    const [chunk] = await tx
      .select()
      .from(sourceChunks)
      .where(and(eq(sourceChunks.sourceId, sourceId), eq(sourceChunks.ordinal, ordinal)))
      .limit(1);
    if (chunk === undefined) throw new AuthError('NOT_FOUND');
    const [bounds] = await tx
      .select({ last: max(sourceChunks.ordinal) })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, sourceId));
    let view: ChunkViewDto['highlight'] = null;
    const { charStart, charEnd } = highlight;
    if (charStart !== undefined && charEnd !== undefined) {
      if (charEnd > chunk.text.length) {
        throw new AuthError('VALIDATION_ERROR', [
          { path: 'charEnd', message: 'Au-delà de la fin du morceau.' },
        ]);
      }
      view = {
        charStart,
        charEnd,
        before: chunk.text.slice(0, charStart),
        match: chunk.text.slice(charStart, charEnd),
        after: chunk.text.slice(charEnd),
      };
    }
    return {
      source: {
        id: source.id,
        kind: source.kind as SourceKind,
        title: source.title,
        revision: source.revision,
      },
      chunk: {
        id: chunk.id,
        ordinal: chunk.ordinal,
        text: chunk.text,
        locator: chunk.locator as ChunkLocator | null,
      },
      previousOrdinal: ordinal > 0 ? ordinal - 1 : null,
      nextOrdinal:
        bounds?.last !== undefined && bounds.last !== null && ordinal < bounds.last
          ? ordinal + 1
          : null,
      highlight: view,
    };
  }

  /**
   * URL présignée de téléchargement (5 minutes), délivrée uniquement après la garde de droits :
   * l'appelant a déjà franchi `PolicyGuard`, et la source est relue sous RLS.
   */
  async downloadUrl(tx: MissionTx, sourceId: string): Promise<PresignedUrlDto> {
    const row = await this.load(tx, sourceId);
    if (row.storageKey === null) throw new AuthError('NOT_FOUND');
    return {
      url: await this.storage.presignSourceDownload(row.storageKey, row.title),
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
      filename: row.title,
    };
  }
}
