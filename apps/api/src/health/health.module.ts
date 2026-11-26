import { Module } from '@nestjs/common';
import { envProvider } from '../env.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { DbProbe, S3Probe } from './probes.js';

@Module({
  controllers: [HealthController],
  providers: [envProvider, DbProbe, S3Probe, HealthService],
})
export class HealthModule {}
