import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  highlightQuerySchema,
  MAX_UPLOAD_BYTES,
  type ChunkDto,
  type ChunkViewDto,
  type HighlightQuery,
  type PresignedUrlDto,
  type RunDto,
  type SourceDto,
  type UploadSourceResult,
} from '@processia/contracts';
import { z } from 'zod';
import { AuthError } from '../auth/errors.js';
import { CurrentAuth, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can, CurrentMission } from '../policy/decorators.js';
import { MissionContext } from '../policy/mission-context.js';
import { SourcesService } from './sources.service.js';

/** Fichier reçu en mémoire par multer (champs utilisés seulement). */
interface UploadedDocument {
  originalname: string;
  buffer: Buffer;
  size: number;
}

const uuidParam = new ZodPipe(z.string().uuid());
const ordinalParam = new ZodPipe(z.coerce.number().int().nonnegative());

/**
 * Sources de la mission : dépôt de documents, texte figé, morceaux et visionneuse. Toutes les
 * routes portent `:missionId` (mission non visible = 404, droit insuffisant = 403).
 */
@Controller('missions/:missionId')
export class SourcesController {
  constructor(@Inject(SourcesService) private readonly sources: SourcesService) {}

  /** Dépôt multipart (champ `file`) : type vérifié par signature, 50 Mo au plus. */
  @Can('model.edit')
  @Post('sources/documents')
  @UseInterceptors(
    // Un octet de plus que la limite : le dépassement est signalé par notre propre code d'erreur.
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: 1 } }),
  )
  async upload(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @UploadedFile() file: UploadedDocument | undefined,
  ): Promise<UploadSourceResult> {
    if (file === undefined) {
      throw new AuthError('VALIDATION_ERROR', [{ path: 'file', message: 'Fichier manquant.' }]);
    }
    if (file.size > MAX_UPLOAD_BYTES) throw new AuthError('FILE_TOO_LARGE');
    // Les navigateurs envoient le nom en Latin-1 : on le relit en UTF-8.
    const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return this.sources.uploadDocument(ctx, auth.user.id, { originalname, buffer: file.buffer });
  }

  /** « Analyser » : fige la description Yjs en source `free_text` (révision suivante). */
  @Can('model.edit')
  @Post('sources/description')
  freezeDescription(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<SourceDto> {
    return this.sources.freezeDescription(ctx, auth.user.id);
  }

  @Can('mission.read_workspace')
  @Get('sources')
  list(@CurrentMission() ctx: MissionContext): Promise<SourceDto[]> {
    return ctx.run((tx) => this.sources.list(tx));
  }

  @Can('mission.read_workspace')
  @Get('sources/:sourceId')
  detail(
    @CurrentMission() ctx: MissionContext,
    @Param('sourceId', uuidParam) sourceId: string,
  ): Promise<SourceDto> {
    return ctx.run((tx) => this.sources.detail(tx, sourceId));
  }

  @Can('mission.read_workspace')
  @Get('sources/:sourceId/chunks')
  chunks(
    @CurrentMission() ctx: MissionContext,
    @Param('sourceId', uuidParam) sourceId: string,
  ): Promise<ChunkDto[]> {
    return ctx.run((tx) => this.sources.chunks(tx, sourceId));
  }

  /** Visionneuse : un morceau, avec le passage `charStart`–`charEnd` découpé pour le surlignage. */
  @Can('mission.read_workspace')
  @Get('sources/:sourceId/chunks/:ordinal')
  chunk(
    @CurrentMission() ctx: MissionContext,
    @Param('sourceId', uuidParam) sourceId: string,
    @Param('ordinal', ordinalParam) ordinal: number,
    @Query(new ZodPipe(highlightQuerySchema)) query: HighlightQuery,
  ): Promise<ChunkViewDto> {
    return ctx.run((tx) => this.sources.chunkView(tx, sourceId, ordinal, query));
  }

  /** URL présignée (5 minutes), délivrée après la garde de droits. */
  @Can('mission.read_workspace')
  @Get('sources/:sourceId/download-url')
  downloadUrl(
    @CurrentMission() ctx: MissionContext,
    @Param('sourceId', uuidParam) sourceId: string,
  ): Promise<PresignedUrlDto> {
    return ctx.run((tx) => this.sources.downloadUrl(tx, sourceId));
  }

  /** Progression d'une exécution d'extraction (même contenu que le message `run.progress`). */
  @Can('mission.read_workspace')
  @Get('runs/:runId')
  run(
    @CurrentMission() ctx: MissionContext,
    @Param('runId', uuidParam) runId: string,
  ): Promise<RunDto> {
    return ctx.run((tx) => this.sources.run(tx, runId));
  }
}
