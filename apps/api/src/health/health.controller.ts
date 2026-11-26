import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Public } from '../auth/http.js';
import { HealthService, type HealthReport } from './health.service.js';

@Public()
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
