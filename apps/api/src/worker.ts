/**
 * Point d'entrée du worker : consomme les tâches pg-boss (extraction de documents, WP-11 ; les
 * pipelines d'analyse et les exports s'y ajouteront). Il partage les modules Nest de l'API, sans
 * écouter de port HTTP.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { JobsService } from './jobs/jobs.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  await app.get(JobsService).startConsuming();
  console.info('Worker Processia démarré : tâches pg-boss en cours de consommation.');
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
