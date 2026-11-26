import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '@processia/config/env';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  await app.listen(env.API_PORT, '0.0.0.0');
  console.info(`API Processia à l'écoute sur le port ${env.API_PORT}`);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
