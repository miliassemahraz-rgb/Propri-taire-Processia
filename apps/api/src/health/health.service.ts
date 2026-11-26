import { Inject, Injectable } from '@nestjs/common';
import { DbProbe, S3Probe, type Probe } from './probes.js';

export type ProbeStatus = 'ok' | 'error';
export interface HealthReport {
  db: ProbeStatus;
  s3: ProbeStatus;
}

async function run(probe: Probe): Promise<ProbeStatus> {
  try {
    await probe.check();
    return 'ok';
  } catch {
    return 'error';
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DbProbe) private readonly db: Probe,
    @Inject(S3Probe) private readonly s3: Probe,
  ) {}

  async check(): Promise<HealthReport> {
    const [db, s3] = await Promise.all([run(this.db), run(this.s3)]);
    return { db, s3 };
  }
}
