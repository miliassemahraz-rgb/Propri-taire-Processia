import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { HealthService, type HealthReport } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  async get(): Promise<HealthReport> {
    const report = await this.health.check();
    if (report.db !== 'ok' || report.s3 !== 'ok') {
      throw new HttpException(report, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return report;
  }
}
