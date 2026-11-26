import { Global, Module } from '@nestjs/common';
import { JobsService } from './jobs.service.js';

/** File de tâches pg-boss : producteur dans l'API, consommateur dans le worker (WP-11). */
@Global()
@Module({
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
