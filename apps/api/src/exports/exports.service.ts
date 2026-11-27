import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import {
  DOSSIER_PURPOSE,
  EXPORT_FORMATS,
  EXPORT_RUN_KIND,
  PRESIGNED_URL_TTL_SECONDS,
  type DeliverablesPreviewDto,
  type ExportArtifactDto,
  type ExportFormat,
  type PresignedUrlDto,
  type StartExportResult,
} from '@processia/contracts';
import {
  analysisRuns,
  artifacts,
  clients,
  missions,
  modelVersions,
  notifications,
  sources,
  withMission,
  type Database,
  type MissionTx,
} from '@processia/db';
import {
  buildDossier,
  EXPORT_FORMAT_META,
  renderDocx,
  renderPdf,
  renderXlsx,
  sha256Hex,
  type DossierInput,
} from '@processia/exports';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuthError } from '../auth/errors.js';
import { DB } from '../db/db.module.js';
import { ENV } from '../env.js';
import { JOB_QUEUES, JobsService } from '../jobs/jobs.service.js';
import { ModelService } from '../model/model.service.js';
import type { MissionContext } from '../policy/mission-context.js';
import { updateRun } from '../sources/runs.js';
import { artifactKey, StorageService } from '../storage/storage.service.js';

const jobDataSchema = z.object({
  missionId: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string().uuid(),
  format: z.enum(EXPORT_FORMATS),
  modelVersion: z.number().int().nonnegative(),
});
export type ExportJobData = z.infer<typeof jobDataSchema>;

/** Radical du nom de fichier : le nom de la mission, sans accents ni ponctuation. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? 'mission' : slug;
}

/** `dossier-analyse-<mission>-v<version>.<extension>` */
export function exportFilename(missionName: string, version: number, format: ExportFormat): string {
  return `dossier-analyse-${slugify(missionName)}-v${version}.${EXPORT_FORMAT_META[format].extension}`;
}

type ArtifactRow = typeof artifacts.$inferSelect;

function toDto(row: ArtifactRow): ExportArtifactDto {
  return {
    id: row.id,
    format: row.kind as ExportFormat,
    modelVersion: row.modelVersion ?? 0,
    sha256: row.sha256,
    filename: row.storageKey.split('/').at(-1) ?? row.storageKey,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}

/**
 * Livrables de l'étape 1 et exports du dossier d'analyse (WP-15, spécification 6.4). Les contenus
 * passent toujours par `deliverableView` (via `buildDossier`) : aucune hypothèse. Un export est
 * une tâche du worker (`export.create`) qui écrit l'artefact dans S3 et le lie à la version du
 * modèle, avec son empreinte sha256.
 */
@Injectable()
export class ExportsService implements OnModuleInit {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(ModelService) private readonly models: ModelService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  onModuleInit(): void {
    this.jobs.addConsumer(JOB_QUEUES.exportCreate, (data) => this.process(data));
  }

  // ------------------------------------------------------------------ entrées du dossier

  /** Modèle d'une version (tête par défaut), sources et mission : tout ce que `buildDossier` consomme. */
  private async loadInput(
    tx: MissionTx,
    missionId: string,
    version: number | undefined,
  ): Promise<{ input: DossierInput; version: number; missionName: string }> {
    const { version: target, model } = await this.models.getModel(tx, missionId, version);
    const [mission] = await tx
      .select({ name: missions.name, createdAt: missions.createdAt, clientName: clients.name })
      .from(missions)
      .innerJoin(clients, eq(clients.id, missions.clientId))
      .where(eq(missions.id, missionId))
      .limit(1);
    if (mission === undefined) throw new AuthError('NOT_FOUND');
    const [row] = await tx
      .select({ createdAt: modelVersions.createdAt })
      .from(modelVersions)
      .where(and(eq(modelVersions.missionId, missionId), eq(modelVersions.version, target)))
      .limit(1);
    const rows = await tx.select().from(sources).orderBy(asc(sources.createdAt), asc(sources.id));
    return {
      version: target,
      missionName: mission.name,
      input: {
        model,
        sources: rows.map((s) => ({
          id: s.id,
          kind: s.kind as 'free_text' | 'answer' | 'document',
          title: s.title,
          revision: s.revision,
        })),
        mission: { name: mission.name, clientName: mission.clientName },
        // Version 0 (modèle vide) : la date de création de la mission.
        producedAt: (row?.createdAt ?? mission.createdAt).toISOString(),
      },
    };
  }

  /** Aperçu HTML des 4 livrables : le même document que celui des exports. */
  async preview(
    tx: MissionTx,
    missionId: string,
    version?: number,
  ): Promise<DeliverablesPreviewDto> {
    const loaded = await this.loadInput(tx, missionId, version);
    return { version: loaded.version, document: buildDossier(loaded.input) };
  }

  // ------------------------------------------------------------------ artefacts

  async list(tx: MissionTx): Promise<ExportArtifactDto[]> {
    const rows = await tx
      .select()
      .from(artifacts)
      .where(eq(artifacts.purpose, DOSSIER_PURPOSE))
      .orderBy(desc(artifacts.createdAt), desc(artifacts.id));
    return rows.map(toDto);
  }

  async downloadUrl(tx: MissionTx, artifactId: string): Promise<PresignedUrlDto> {
    const [row] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
    if (row === undefined) throw new AuthError('NOT_FOUND');
    const dto = toDto(row);
    return {
      url: await this.storage.presignArtifactDownload(
        row.storageKey,
        dto.filename,
        EXPORT_FORMAT_META[dto.format].mime,
      ),
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
      filename: dto.filename,
    };
  }

  // ------------------------------------------------------------------ lancement

  /** Fige la version de tête et met la tâche en file ; suivi par `run.progress` (kind `export`). */
  async start(
    ctx: MissionContext,
    userId: string,
    format: ExportFormat,
  ): Promise<StartExportResult> {
    const created = await ctx.run(async (tx) => {
      const modelVersion = await this.models.headVersion(tx, ctx.missionId);
      const [run] = await tx
        .insert(analysisRuns)
        .values({
          missionId: ctx.missionId,
          kind: EXPORT_RUN_KIND,
          status: 'queued',
          progress: 0,
          startedBy: userId,
        })
        .returning();
      if (run === undefined) throw new Error('Insertion de l’exécution impossible.');
      await updateRun(tx, ctx.missionId, run.id, null, {});
      return { runId: run.id, modelVersion };
    });
    const data: ExportJobData = {
      missionId: ctx.missionId,
      runId: created.runId,
      userId,
      format,
      modelVersion: created.modelVersion,
    };
    try {
      const jobId = await this.jobs.send(JOB_QUEUES.exportCreate, data);
      await withMission(this.db, ctx.missionId, (tx) =>
        updateRun(tx, ctx.missionId, created.runId, null, { jobId }),
      );
    } catch (error) {
      await withMission(this.db, ctx.missionId, (tx) =>
        updateRun(tx, ctx.missionId, created.runId, null, {
          status: 'failed',
          error: 'JOB_ENQUEUE_FAILED',
        }),
      );
      throw error;
    }
    return created;
  }

  // ------------------------------------------------------------------ traitement (worker)

  async process(raw: unknown): Promise<void> {
    const data = jobDataSchema.parse(raw);
    const { missionId, runId } = data;
    const progress = (value: number): Promise<unknown> =>
      withMission(this.db, missionId, (tx) =>
        updateRun(tx, missionId, runId, null, { status: 'running', progress: value }),
      );
    try {
      await progress(5);
      const loaded = await withMission(this.db, missionId, (tx) =>
        this.loadInput(tx, missionId, data.modelVersion),
      );
      const doc = buildDossier(loaded.input);
      await progress(30);
      const bytes = await this.render(data.format, doc, loaded.input.producedAt);
      await progress(80);
      const artifactId = randomUUID();
      const filename = exportFilename(loaded.missionName, loaded.version, data.format);
      const storageKey = artifactKey(missionId, artifactId, filename);
      await this.storage.putArtifact(storageKey, bytes, EXPORT_FORMAT_META[data.format].mime);
      await withMission(this.db, missionId, async (tx) => {
        await tx.insert(artifacts).values({
          id: artifactId,
          missionId,
          kind: data.format,
          purpose: DOSSIER_PURPOSE,
          modelVersion: loaded.version,
          storageKey,
          sha256: sha256Hex(bytes),
          createdBy: data.userId,
        });
        await updateRun(tx, missionId, runId, null, {
          status: 'succeeded',
          progress: 100,
          resultVersion: loaded.version,
        });
        await tx.insert(notifications).values({
          userId: data.userId,
          missionId,
          kind: 'export.done',
          payload: { runId, artifactId, format: data.format, version: loaded.version },
        });
      });
    } catch (error) {
      this.logger.error(`Export ${data.format} ${runId} en échec : ${(error as Error).message}`);
      const message = (error as Error).message.slice(0, 500);
      await withMission(this.db, missionId, async (tx) => {
        await updateRun(tx, missionId, runId, null, {
          status: 'failed',
          progress: 100,
          error: message,
        });
        await tx.insert(notifications).values({
          userId: data.userId,
          missionId,
          kind: 'export.failed',
          payload: { runId, format: data.format, error: message.slice(0, 200) },
        });
      });
    }
  }

  private render(
    format: ExportFormat,
    doc: ReturnType<typeof buildDossier>,
    producedAt: string,
  ): Promise<Uint8Array> {
    switch (format) {
      case 'docx':
        return renderDocx(doc, producedAt);
      case 'xlsx':
        return renderXlsx(doc, producedAt);
      case 'pdf':
        return renderPdf(doc, { executablePath: this.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
    }
  }
}
