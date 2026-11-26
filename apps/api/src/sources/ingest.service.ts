import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { documentVisualPipeline } from '@processia/ai';
import {
  missions,
  notifications,
  sourceChunks,
  sources,
  withMission,
  withoutMission,
  type Database,
} from '@processia/db';
import {
  blocksFromPages,
  chunkBlocks,
  detectFile,
  extractDocumentText,
  type TextBlock,
} from '@processia/ingest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AiProviderRegistry } from '../ai/ai-provider.registry.js';
import { AiService } from '../ai/ai.service.js';
import { DB } from '../db/db.module.js';
import { JOB_QUEUES, JobsService } from '../jobs/jobs.service.js';
import { StorageService } from '../storage/storage.service.js';
import { updateRun } from './runs.js';
import { insertChunks, type IngestJobData } from './sources.service.js';

const jobDataSchema = z.object({
  missionId: z.string().uuid(),
  sourceId: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string().uuid(),
});

/** Document illisible : scan ou image sans fournisseur doté de `documents`, ou texte absent. */
export const UNREADABLE_ERROR = 'SOURCE_UNREADABLE';

/**
 * Tâche `ingest.document` du worker : lit le fichier dans S3, extrait le texte, le découpe en
 * morceaux localisés et met à jour la source. La progression est diffusée par `run.progress`.
 * Un PDF scanné ou une image passe par `extraction.document_visual` si le client dispose de la
 * capacité `documents` ; sinon la source reçoit le statut « non lisible » et l'auteur est averti.
 */
@Injectable()
export class IngestService implements OnModuleInit {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AiProviderRegistry) private readonly registry: AiProviderRegistry,
  ) {}

  onModuleInit(): void {
    this.jobs.addConsumer(JOB_QUEUES.ingestDocument, (data) => this.process(data));
  }

  async process(raw: unknown): Promise<void> {
    const data: IngestJobData = jobDataSchema.parse(raw);
    const { missionId, sourceId, runId, userId } = data;
    const step = (progress: number, status: 'running' = 'running') =>
      withMission(this.db, missionId, (tx) =>
        updateRun(tx, missionId, runId, sourceId, { status, progress }),
      );

    try {
      const source = await withMission(this.db, missionId, async (tx) => {
        const [row] = await tx.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
        if (row !== undefined) {
          await updateRun(tx, missionId, runId, sourceId, { status: 'running', progress: 5 });
        }
        return row;
      });
      if (source === undefined || source.storageKey === null) {
        this.logger.warn(`Source ${sourceId} introuvable : tâche ignorée.`);
        return;
      }

      const buffer = await this.storage.getSource(source.storageKey);
      await step(20);
      const detected = await detectFile(buffer, source.title);
      const extraction = await extractDocumentText(detected.kind, buffer);
      await step(45);

      let blocks: TextBlock[];
      if (extraction.status === 'ok') {
        blocks = extraction.blocks;
      } else {
        const clientId = await this.clientOf(missionId);
        if (!(await this.registry.supportsDocuments(clientId))) {
          await this.markUnreadable(data, source.title, extraction.reason);
          return;
        }
        const run = await this.ai.run(
          documentVisualPipeline,
          {
            name: source.title,
            kind: detected.kind === 'pdf' ? 'pdf' : 'image',
            mediaType: detected.mime,
            data: buffer,
          },
          { missionId, userId },
        );
        blocks = blocksFromPages(run.output.pages);
        await step(70);
      }

      const chunks = chunkBlocks(blocks);
      if (chunks.length === 0) {
        await this.markUnreadable(data, source.title, 'empty');
        return;
      }
      await withMission(this.db, missionId, async (tx) => {
        await tx.delete(sourceChunks).where(eq(sourceChunks.sourceId, sourceId));
        await insertChunks(tx, missionId, sourceId, chunks);
        await tx.update(sources).set({ textStatus: 'extracted' }).where(eq(sources.id, sourceId));
        await updateRun(tx, missionId, runId, sourceId, { status: 'succeeded', progress: 100 });
      });
    } catch (error) {
      this.logger.error(`Extraction de ${sourceId} en échec : ${(error as Error).message}`);
      await this.markFailed(data, error as Error);
    }
  }

  private async clientOf(missionId: string): Promise<string> {
    const [row] = await withoutMission(this.db, (tx) =>
      tx.select({ clientId: missions.clientId }).from(missions).where(eq(missions.id, missionId)),
    );
    if (row === undefined) throw new Error('Mission introuvable.');
    return row.clientId;
  }

  /** Statut « non lisible », signalé : exécution en échec et notification à l'auteur du dépôt. */
  private async markUnreadable(data: IngestJobData, title: string, reason: string): Promise<void> {
    await withMission(this.db, data.missionId, async (tx) => {
      await tx
        .update(sources)
        .set({ textStatus: 'unreadable' })
        .where(eq(sources.id, data.sourceId));
      await updateRun(tx, data.missionId, data.runId, data.sourceId, {
        status: 'failed',
        progress: 100,
        error: UNREADABLE_ERROR,
      });
      await tx.insert(notifications).values({
        userId: data.userId,
        missionId: data.missionId,
        kind: 'source.unreadable',
        payload: { sourceId: data.sourceId, title, reason },
      });
    });
  }

  private async markFailed(data: IngestJobData, error: Error): Promise<void> {
    await withMission(this.db, data.missionId, async (tx) => {
      await tx.update(sources).set({ textStatus: 'failed' }).where(eq(sources.id, data.sourceId));
      await updateRun(tx, data.missionId, data.runId, data.sourceId, {
        status: 'failed',
        progress: 100,
        error: error.message.slice(0, 500),
      });
      await tx.insert(notifications).values({
        userId: data.userId,
        missionId: data.missionId,
        kind: 'source.failed',
        payload: { sourceId: data.sourceId },
      });
    });
  }
}
