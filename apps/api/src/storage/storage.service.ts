import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Env } from '@processia/config/env';
import { PRESIGNED_URL_TTL_SECONDS } from '@processia/contracts';
import { ENV } from '../env.js';

/** Nom de fichier sûr pour une clé S3 et un en-tête `Content-Disposition`. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'document';
  const cleaned = base
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f"\\<>|?*:]/g, '_')
    .trim();
  return cleaned.length === 0 ? 'document' : cleaned.slice(0, 200);
}

/** Clé d'un fichier source : toujours préfixée par la mission (spécification 3.3). */
export function sourceKey(missionId: string, sourceId: string, filename: string): string {
  return `missions/${missionId}/sources/${sourceId}/${safeFilename(filename)}`;
}

/** Clé d'un export : préfixée par la mission, une entrée par artefact (WP-15). */
export function artifactKey(missionId: string, artifactId: string, filename: string): string {
  return `missions/${missionId}/exports/${artifactId}/${safeFilename(filename)}`;
}

/**
 * Stockage S3 (MinIO en local). Les buckets sont privés : seule l'API délivre des URL présignées,
 * après la garde de droits (spécification 1.1 et 3.3).
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly sourcesBucket: string;
  private readonly artifactsBucket: string;

  constructor(@Inject(ENV) env: Env) {
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    });
    this.sourcesBucket = env.S3_BUCKET_SOURCES;
    this.artifactsBucket = env.S3_BUCKET_ARTIFACTS;
  }

  async putSource(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.sourcesBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getSource(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.sourcesBucket, Key: key }),
    );
    if (res.Body === undefined) throw new Error(`Objet S3 vide : ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async deleteSource(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.sourcesBucket, Key: key }));
  }

  /** URL de téléchargement présignée, valable 5 minutes. */
  presignSourceDownload(
    key: string,
    filename: string,
    expiresInSeconds: number = PRESIGNED_URL_TTL_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.sourcesBucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  /** Écrit un export (bucket des artefacts). */
  async putArtifact(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.artifactsBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getArtifact(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.artifactsBucket, Key: key }),
    );
    if (res.Body === undefined) throw new Error(`Objet S3 vide : ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  /** URL de téléchargement présignée d'un export, valable 5 minutes. */
  presignArtifactDownload(
    key: string,
    filename: string,
    contentType: string,
    expiresInSeconds: number = PRESIGNED_URL_TTL_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.artifactsBucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
