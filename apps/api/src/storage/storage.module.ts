import { Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';

/** Stockage S3 des fichiers sources (WP-11) ; et des exports produits (WP-15). */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
