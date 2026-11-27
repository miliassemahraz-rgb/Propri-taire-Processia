import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  modelQuerySchema,
  startExportSchema,
  type DeliverablesPreviewDto,
  type ExportArtifactDto,
  type PresignedUrlDto,
  type StartExportRequest,
  type StartExportResult,
} from '@processia/contracts';
import { z } from 'zod';
import { AuthError } from '../auth/errors.js';
import { CurrentAuth, ZodPipe } from '../auth/http.js';
import type { AuthContext } from '../auth/sessions.service.js';
import { Can, CurrentMission } from '../policy/decorators.js';
import { MissionContext } from '../policy/mission-context.js';
import { ExportsService } from './exports.service.js';

const uuidParam = new ZodPipe(z.string().uuid());

/**
 * Livrables de l'étape 1 et exports du dossier d'analyse. Le validateur n'y a pas accès : il ne
 * voit que les versions figées de ses soumissions (WP-16).
 */
@Controller('missions/:missionId')
export class ExportsController {
  constructor(@Inject(ExportsService) private readonly exportsService: ExportsService) {}

  /** Aperçu des 4 livrables (version demandée, tête par défaut), sans hypothèse. */
  @Can('mission.read_workspace')
  @Get('deliverables')
  preview(
    @CurrentMission() ctx: MissionContext,
    @Query(new ZodPipe(modelQuerySchema)) query: { version?: number | undefined },
  ): Promise<DeliverablesPreviewDto> {
    return ctx.run((tx) => this.exportsService.preview(tx, ctx.missionId, query.version));
  }

  @Can('mission.read_workspace')
  @Get('exports')
  list(@CurrentMission() ctx: MissionContext): Promise<ExportArtifactDto[]> {
    return ctx.run((tx) => this.exportsService.list(tx));
  }

  /** URL présignée (5 minutes), délivrée après la garde de droits. */
  @Can('mission.read_workspace')
  @Get('exports/:artifactId/download-url')
  downloadUrl(
    @CurrentMission() ctx: MissionContext,
    @Param('artifactId', uuidParam) artifactId: string,
  ): Promise<PresignedUrlDto> {
    return ctx.run((tx) => this.exportsService.downloadUrl(tx, artifactId));
  }

  /** Produit le dossier d'analyse dans un format, à partir de la version de tête. */
  @Can('export.create')
  @Post('exports')
  start(
    @CurrentMission() ctx: MissionContext,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(startExportSchema)) body: StartExportRequest,
  ): Promise<StartExportResult> {
    // La matrice accorde `export.create` au validateur sur « ses » soumissions (WP-16) ; le
    // dossier de travail, lui, lui est fermé.
    if (ctx.missionRole === 'validator') throw new AuthError('FORBIDDEN');
    return this.exportsService.start(ctx, auth.user.id, body.format);
  }
}
